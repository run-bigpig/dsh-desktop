import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { toMarkdown, toMarkdownBytes, type Format } from '@firecrawl/anydoc'
import type { DocumentUploadRequest, DocumentUploadResult } from '../shared/types.ts'

const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_MARKDOWN_CHARACTERS = 5_000_000
const DEFAULT_READ_CHARACTERS = 12_000
const MAX_READ_CHARACTERS = 30_000
const DOCUMENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/

const FORMAT_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.doc': 'doc', '.docx': 'docx', '.docm': 'docx',
  '.ppt': 'ppt', '.pps': 'ppt', '.pot': 'ppt', '.pptx': 'pptx', '.pptm': 'pptx', '.ppsx': 'pptx', '.ppsm': 'pptx',
  '.xls': 'xlsx', '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.xlsb': 'xlsx',
  '.odt': 'odt', '.ods': 'ods', '.odp': 'odp', '.rtf': 'rtf', '.epub': 'epub', '.csv': 'csv', '.pdf': 'pdf',
}

const ERROR_HINTS: Readonly<Record<string, string>> = {
  unsupported: '不支持的文件格式或无法转换的内容',
  malformed: '文件结构损坏，无法提取有效内容',
  encrypted: '文件已加密或受密码保护',
  resourceLimit: '超出安全限制（解压、嵌套或节点数）',
  missingPart: '缺少生成输出所需的部件',
  io: '无法读取文件',
}

export interface DocumentGatewayConfig {
  readonly path: string
}

interface StoredDocumentMetadata {
  readonly id: string
  readonly name: string
  readonly sourceBytes: number
  readonly markdownCharacters: number
}

export class DocumentGateway extends TypertRemoteService {
  static inject = ['tools']
  static Config: z<DocumentGatewayConfig> = z.object({ path: z.string().required() })

  private readonly directory: string

  constructor(ctx: Context, config: DocumentGatewayConfig) {
    super(ctx, 'documents')
    this.directory = resolve(config.path)
    this.ctx.effect(() => this.ctx.tools.register(this.anydocTool()), 'desktop-documents: anydoc tool')
    this.ctx.effect(() => this.ctx.tools.register(this.readUploadedDocumentTool()), 'desktop-documents: uploaded document tool')
    const systemPrompt = this.ctx.get('systemPrompt')
    systemPrompt?.section({
      name: 'desktop-uploaded-documents',
      order: 81,
      text: [
        'User messages may contain markers like [Document: filename | id=sha256:...].',
        'The document was converted locally to Markdown.',
        'Use read_uploaded_document with that id to inspect it in chunks before answering.',
        'Read further chunks when the tool reports remaining content; do not claim to have read sections you did not request.',
      ].join(' '),
    })
  }

  @Remote('uploadDocument')
  async uploadDocument(request: DocumentUploadRequest): Promise<DocumentUploadResult> {
    const name = safeDocumentName(request.name)
    if (request.base64.length > Math.ceil(MAX_SOURCE_BYTES * 4 / 3) + 16) {
      throw new Error(`document upload exceeds ${String(MAX_SOURCE_BYTES)} bytes`)
    }
    const bytes = decodeBase64(request.base64)
    if (bytes.byteLength === 0) throw new Error('document upload is empty')
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`document upload exceeds ${String(MAX_SOURCE_BYTES)} bytes`)
    const format = FORMAT_BY_EXTENSION[extname(name).toLocaleLowerCase()]
    if (format === undefined) throw new Error(`unsupported document extension: ${extname(name) || '(none)'}`)
    const markdown = await convertBytes(bytes, format as Format, name)
    if (markdown.length > MAX_MARKDOWN_CHARACTERS) {
      throw new Error(`converted document exceeds ${String(MAX_MARKDOWN_CHARACTERS)} characters`)
    }

    const digest = createHash('sha256').update(bytes).digest('hex')
    const id = `sha256:${digest}`
    const metadata: StoredDocumentMetadata = {
      id,
      name,
      sourceBytes: bytes.byteLength,
      markdownCharacters: markdown.length,
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.markdownPath(digest), markdown, { mode: 0o600, dirMode: 0o700 })
    await writeFileAtomic(this.metadataPath(digest), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return { ...metadata, marker: documentMarker(metadata) }
  }

  private anydocTool() {
    return defineTool({
      name: 'anydoc',
      description: '将本机文档（Word、PowerPoint、Excel、PDF、EPUB、RTF、CSV、OpenDocument）转换为 GitHub-Flavored Markdown。',
      parameters: {
        filePath: { type: 'string', required: true, description: '要转换文件的绝对路径或相对路径' },
        format: { type: 'string', description: '可选，显式指定格式（如 csv）' },
        outputFilePath: { type: 'string', description: '可选，将 Markdown 写入文件并返回摘要' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        const markdown = await convertPath(args.filePath, args.format)
        if (args.outputFilePath) {
          await writeFile(args.outputFilePath, markdown, 'utf8')
          return `已转换 "${args.filePath}" 并写入 "${args.outputFilePath}"（${String(markdown.length)} 字符）。`
        }
        return markdown
      },
    })
  }

  private readUploadedDocumentTool() {
    const directory = this.directory
    return defineTool({
      name: 'read_uploaded_document',
      description: '按字符区间读取用户已上传并转换为 Markdown 的文档。',
      parameters: {
        documentId: { type: 'string', required: true, description: '消息中 Document 标记的 sha256 id' },
        offset: { type: 'integer', description: '开始字符位置，默认 0' },
        limit: { type: 'integer', description: `本次最多读取字符数，最大 ${String(MAX_READ_CHARACTERS)}` },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!DOCUMENT_ID_PATTERN.test(args.documentId)) throw new Error('invalid uploaded document id')
        const digest = args.documentId.slice('sha256:'.length)
        const metadata = JSON.parse(await readFile(resolve(directory, `${digest}.json`), 'utf8')) as StoredDocumentMetadata
        const markdown = await readFile(resolve(directory, `${digest}.md`), 'utf8')
        const offset = clampInteger(args.offset, 0, markdown.length, 0)
        const limit = clampInteger(args.limit, 1, MAX_READ_CHARACTERS, DEFAULT_READ_CHARACTERS)
        const end = Math.min(markdown.length, offset + limit)
        const remaining = markdown.length - end
        return [
          `Document: ${metadata.name}`,
          `Characters: ${String(offset)}-${String(end)} of ${String(markdown.length)}`,
          remaining > 0 ? `Remaining: ${String(remaining)}; continue with offset ${String(end)}.` : 'Remaining: 0.',
          '',
          markdown.slice(offset, end),
        ].join('\n')
      },
    })
  }

  private markdownPath(digest: string): string {
    return resolve(this.directory, `${digest}.md`)
  }

  private metadataPath(digest: string): string {
    return resolve(this.directory, `${digest}.json`)
  }
}

async function convertBytes(bytes: Uint8Array, format: Format, name: string): Promise<string> {
  try {
    const markdown = (await toMarkdownBytes(bytes, format)).trim()
    if (markdown.length === 0) throw new Error('conversion returned empty content')
    return markdown
  } catch (error) {
    throw conversionError(name, error)
  }
}

async function convertPath(filePath: string, explicitFormat?: string): Promise<string> {
  try {
    const markdown = explicitFormat
      ? await toMarkdownBytes(await readFile(filePath), explicitFormat as Format)
      : await toMarkdown(filePath)
    if (markdown.trim().length === 0) throw new Error('conversion returned empty content')
    return markdown
  } catch (error) {
    throw conversionError(filePath, error)
  }
}

function conversionError(name: string, error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
  const hint = code === undefined || ERROR_HINTS[code] === undefined ? '' : `（${ERROR_HINTS[code]}）`
  return new Error(`转换 "${name}" 失败: ${error instanceof Error ? error.message : String(error)}${hint}`)
}

function safeDocumentName(value: string): string {
  const name = value.replaceAll('\\', '/').split('/').pop()?.replace(/[\u0000-\u001f\u007f]/gu, '').trim() ?? ''
  if (name.length === 0) throw new Error('document name is empty')
  return name.slice(0, 240)
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) throw new Error('document payload is not valid base64')
  return Buffer.from(value, 'base64')
}

function documentMarker(metadata: StoredDocumentMetadata): string {
  return `[Document: ${metadata.name} | id=${metadata.id} | ${String(metadata.markdownCharacters)} chars]`
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

export default DocumentGateway
