import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'

const SKILL_NAME = 'thinkingdata-analysis-orchestrator'
const SKILL_DESCRIPTION = '使用数数（ThinkingData）基础查询工具完成事件、漏斗、留存、路径、用户、付费、LTV、只读 SQL 与数据质量分析。'
const LEARNING_TOOL_NAME = 'thinkingdata_learn_correction'
const LEARNING_DOCUMENT_VERSION = 1
const MAX_LEARNINGS = 80
const MAX_LEARNING_FIELD_CHARACTERS = 800
const SKILL_DIRECTORIES = [
  fileURLToPath(new URL('../skills/thinkingdata-analysis-orchestrator/', import.meta.url)),
  fileURLToPath(new URL('../../skills/thinkingdata-analysis-orchestrator/', import.meta.url)),
]

interface ThinkingDataLearning {
  readonly id: string
  readonly errorPattern: string
  readonly correctUsage: string
  readonly appliesWhen: string
  readonly verification: string
  readonly createdAt: string
}

interface ThinkingDataLearningDocument {
  readonly version: 1
  readonly entries: readonly ThinkingDataLearning[]
}

export interface ThinkingDataLearningInput {
  readonly errorPattern: string
  readonly correctUsage: string
  readonly appliesWhen: string
  readonly verification: string
}

export interface ThinkingDataLearningResult {
  readonly stored: boolean
  readonly total: number
}

export async function registerThinkingDataSkill(ctx: Context, learningPath?: string): Promise<() => void> {
  const directory = await findSkillDirectory()
  const baseline = stripFrontmatter(await readFile(resolve(directory, 'SKILL.md'), 'utf8'))
  const content = learningPath === undefined ? baseline : await mergeLearnings(ctx, baseline, learningPath)
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: directory },
    content,
  })
}

export async function replaceThinkingDataSkill(
  ctx: Context,
  learningPath: string,
  disposePrevious?: () => void,
): Promise<() => void> {
  disposePrevious?.()
  return await registerThinkingDataSkill(ctx, learningPath)
}

export function thinkingDataLearningPath(settingsPath: string): string {
  return resolve(dirname(settingsPath), 'thinkingdata-skill-learnings.json')
}

export function registerThinkingDataLearningTool(
  ctx: Context,
  learningPath: string,
  onStored?: () => Promise<void>,
): () => void {
  const store = new ThinkingDataLearningStore(learningPath)
  return ctx.tools.register(defineTool({
    name: LEARNING_TOOL_NAME,
    description: [
      '保存一条已经由成功 ThinkingData 工具调用验证、且可跨项目复用的纠正经验。',
      '只记录错误模式、正确用法、适用条件和验证方式；禁止写入 Token、URL、项目/事件/属性内部名、筛选值、业务数据或完整请求响应。',
      '瞬时网络、鉴权、服务故障和未验证的人类建议不得记录。',
    ].join(''),
    parameters: {
      errorPattern: { type: 'string', required: true, description: '去敏并泛化后的错误模式，不包含业务参数或原始响应。' },
      correctUsage: { type: 'string', required: true, description: '最终成功的通用调用规则，不包含具体项目数据。' },
      appliesWhen: { type: 'string', required: true, description: '该规则适用的工具、参数结构或前置条件。' },
      verification: { type: 'string', required: true, description: '说明哪类最小重试已经成功；不要粘贴完整结果。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stored: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stored
          ? `Stored verified ThinkingData correction (${String(value.total)} total).`
          : `ThinkingData correction already exists (${String(value.total)} total).`,
      }],
    },
    async execute(args) {
      const result = await store.record({
        errorPattern: args.errorPattern,
        correctUsage: args.correctUsage,
        appliesWhen: args.appliesWhen,
        verification: args.verification,
      })
      if (result.stored) await onStored?.()
      return result
    },
  }))
}

export class ThinkingDataLearningStore {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly filename: string) {}

  record(input: ThinkingDataLearningInput): Promise<ThinkingDataLearningResult> {
    return this.enqueue(async () => {
      const normalized = normalizeLearningInput(input)
      const document = await this.read()
      const id = learningId(normalized)
      if (document.entries.some(entry => entry.id === id)) {
        return { stored: false, total: document.entries.length }
      }
      const entry: ThinkingDataLearning = { id, ...normalized, createdAt: new Date().toISOString() }
      const entries = [...document.entries, entry].slice(-MAX_LEARNINGS)
      await writeFileAtomic(this.filename, `${JSON.stringify({ version: LEARNING_DOCUMENT_VERSION, entries }, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
      return { stored: true, total: entries.length }
    })
  }

  async read(): Promise<ThinkingDataLearningDocument> {
    try {
      return parseLearningDocument(await readFile(this.filename, 'utf8'))
    } catch (error) {
      if (isEnoent(error)) return { version: LEARNING_DOCUMENT_VERSION, entries: [] }
      throw error
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

async function findSkillDirectory(): Promise<string> {
  for (const directory of SKILL_DIRECTORIES) {
    try {
      await access(resolve(directory, 'SKILL.md'))
      return directory
    } catch {
      continue
    }
  }
  throw new Error('thinkingdata: bundled skill is missing')
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---\n', 4)
  return end < 0 ? content : content.slice(end + 5)
}

async function mergeLearnings(ctx: Context, baseline: string, learningPath: string): Promise<string> {
  try {
    const document = await new ThinkingDataLearningStore(learningPath).read()
    if (document.entries.length === 0) return baseline
    return `${baseline.trimEnd()}\n\n${renderLearnings(document.entries)}\n`
  } catch (error) {
    ctx.logger.warn('thinkingdata: failed to load learned corrections', error)
    return baseline
  }
}

function renderLearnings(entries: readonly ThinkingDataLearning[]): string {
  const blocks = entries.map((entry, index) => [
    `### ${String(index + 1)}. ${entry.appliesWhen}`,
    '',
    `- 错误模式：${entry.errorPattern}`,
    `- 正确用法：${entry.correctUsage}`,
    `- 成功验证：${entry.verification}`,
  ].join('\n'))
  return [
    '## 已验证的本地纠正经验',
    '',
    '以下经验来自本机成功调用后的持久化总结。当前工具 Schema 和服务端错误路径始终优先；若经验与当前契约冲突，忽略旧经验并在重新验证成功后记录新规则。',
    '',
    ...blocks,
  ].join('\n')
}

function normalizeLearningInput(input: ThinkingDataLearningInput): Omit<ThinkingDataLearning, 'id' | 'createdAt'> {
  return {
    errorPattern: normalizeLearningField('errorPattern', input.errorPattern),
    correctUsage: normalizeLearningField('correctUsage', input.correctUsage),
    appliesWhen: normalizeLearningField('appliesWhen', input.appliesWhen),
    verification: normalizeLearningField('verification', input.verification),
  }
}

function normalizeLearningField(name: string, value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0) throw new Error(`thinkingdata learning: ${name} must not be empty`)
  if (normalized.length > MAX_LEARNING_FIELD_CHARACTERS) {
    throw new Error(`thinkingdata learning: ${name} exceeds ${String(MAX_LEARNING_FIELD_CHARACTERS)} characters`)
  }
  if (containsSensitiveMaterial(normalized)) {
    throw new Error(`thinkingdata learning: ${name} contains unsafe content such as credentials, private values, URLs, or instruction injection`)
  }
  return normalized
}

function containsSensitiveMaterial(value: string): boolean {
  return /\b(?:bearer|authorization|password|passwd|token|api[_ -]?key)\b\s*[:=]?\s*["']?[a-z0-9._~+/=-]{8,}/iu.test(value)
    || /https?:\/\/\S+/iu.test(value)
    || /\bdownload_url\b/iu.test(value)
    || /\b(?:project_id|user_id)\b\s*[:=]\s*["']?[a-z0-9_-]+/iu.test(value)
    || /\b(?:event_name|property_name|column_name)\b\s*[:=]\s*["'][^"']+["']/iu.test(value)
    || /[<>]/u.test(value)
    || /\b(?:ignore|override|bypass)\b.{0,24}\b(?:instruction|prompt|policy|rule)s?\b/iu.test(value)
    || /(?:忽略|覆盖|绕过).{0,16}(?:指令|提示词|规则|安全约束)/u.test(value)
}

function learningId(input: Omit<ThinkingDataLearning, 'id' | 'createdAt'>): string {
  return createHash('sha256')
    .update([input.errorPattern, input.correctUsage, input.appliesWhen].join('\n'))
    .digest('hex')
    .slice(0, 24)
}

function parseLearningDocument(text: string): ThinkingDataLearningDocument {
  const value = JSON.parse(text) as unknown
  if (!isRecord(value) || value.version !== LEARNING_DOCUMENT_VERSION || !Array.isArray(value.entries)) {
    throw new Error('thinkingdata learning: document has an invalid shape')
  }
  const entries = value.entries.map(parseLearningEntry)
  return { version: LEARNING_DOCUMENT_VERSION, entries: entries.slice(-MAX_LEARNINGS) }
}

function parseLearningEntry(value: unknown): ThinkingDataLearning {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.errorPattern !== 'string'
    || typeof value.correctUsage !== 'string'
    || typeof value.appliesWhen !== 'string'
    || typeof value.verification !== 'string'
    || typeof value.createdAt !== 'string') {
    throw new Error('thinkingdata learning: entry has an invalid shape')
  }
  const normalized = normalizeLearningInput({
    errorPattern: value.errorPattern,
    correctUsage: value.correctUsage,
    appliesWhen: value.appliesWhen,
    verification: value.verification,
  })
  if (value.id !== learningId(normalized)) {
    throw new Error('thinkingdata learning: entry id does not match its normalized content')
  }
  return {
    id: value.id,
    ...normalized,
    createdAt: value.createdAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
