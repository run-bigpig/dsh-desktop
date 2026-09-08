import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { desktopRequest } from '../desktop/index.ts'
import type { BrowserCommand, BrowserTab, WorkspacePanelRequest, WorkspaceRequest, WorkspacePresentationSnapshot } from '../shared/types.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WorkspaceDirectorySnapshot,
  WorkspaceEntry,
  WorkspaceFileSnapshot,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
  WorkspaceSearchHit,
  WorkspaceSearchSnapshot,
} from '../shared/types.ts'

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const TREE_SKIP_DIRECTORIES = new Set(['.git'])
const SEARCH_SKIP_DIRECTORIES = new Set(['.git', 'node_modules'])
const SEARCH_HIT_CAP = 200
const SEARCH_SCAN_CAP = 20_000
const SEARCH_DEPTH_CAP = 24
const TEXT_CHARACTER_CAP = 80_000
const BINARY_BYTE_CAP = 8 * 1024 * 1024
const DESIGN_BINARY_BYTE_CAP = 64 * 1024 * 1024

declare module '@deepseek-ai/cordis' {
  interface Context { desktopWorkspace: WorkspaceGateway }
}

/** Session-owned resources and explicit presentation requests. */
export class WorkspaceGateway extends TypertRemoteService {
  static inject = ['tools', 'attachments', 'sessions']
  private readonly requests = new Map<string, WorkspaceRequest>()
  private revision = 0
  private readonly epoch = randomUUID()
  private readonly turns = new Map<string, number>()

  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.root.on('session/event', (session, event) => {
      if (event.type !== 'turn/start') return
      const id = String(session.id)
      this.turns.set(id, event.data.turn)
      this.requests.delete(id)
      this.changed()
    }), 'desktop-workspace: presentation task boundary')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({
      name: 'open_workspace_panel',
      description: '请求向用户展示当前会话的资源。用户要求打开、需要查看结果或接管操作时调用；后台查询和普通工具操作无需展示。用户关闭后同一展示步骤不得反复唤起，新的明确展示步骤可以唤起。后台会话仅提供待查看入口。画布先调用 open_canvas；浏览器先用 workspace_browser 创建或查询真实 tabId。',
      parameters: {
        presentation: { type: 'string', description: '同一展示步骤使用相同标识。仅真正开始新的展示步骤时更换；读取、自动保存、完成原步骤不得更换以反复弹窗。' },
        panel: { type: 'string', enum: ['files', 'git', 'browser', 'canvas'], required: true },
        tabId: { type: 'string', description: '展示浏览器时必填，使用当前会话的真实标签 ID' },
        path: { type: 'string', description: 'files 或 canvas 使用，工作区内文件的相对路径' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('Workspace requires an owning agent session')
        if (args.panel === 'browser') {
          const tabs = JSON.parse(await this.browserCommand(exec.agent, { op: 'list' }, exec.signal)) as BrowserTab[]
          if (!args.tabId || !tabs.some(tab => tab.id === args.tabId)) throw new Error('请使用当前会话的真实浏览器 tabId')
        }
        let path = args.path
        if (args.panel === 'canvas') {
          const design = this.ctx.get('starweaveDesign')
          if (!design) throw new Error('画布服务尚未就绪')
          await design.openFile(exec.agent, args.path ? { path: args.path } : {}, exec.signal)
          path = await design.canvasPath(String(exec.agent.session.id))
        }
        if (args.path !== undefined && args.panel !== 'canvas') {
          if (args.panel !== 'files') throw new Error('path 仅适用于 files')
          await readWorkspaceFile(workspaceRoot(exec.agent), args.path, exec.signal)
        }
        exec.signal.throwIfAborted()
        this.request(exec.agent, args.panel, args.tabId, path, args.presentation)
        return '已请求展示当前会话工作区。'
      },
    })), 'desktop-workspace: reveal session panel')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({
      name: 'close_workspace_panel',
      description: '关闭当前会话右侧的 details 工作台。用户说关闭浏览器、关闭画布、关闭文件/Git 侧栏、收起右侧面板或不再展示时，必须调用本工具。只关闭侧边栏并保留浏览器标签、画布和文件状态；如果用户明确要关闭浏览器标签本身，另用 workspace_browser(action=close)。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, exec) => {
        if (!exec.agent) throw new Error('Workspace requires an owning agent session')
        exec.signal.throwIfAborted()
        this.requestClose(exec.agent)
        return '已请求关闭当前会话侧边栏。'
      },
    })), 'desktop-workspace: close session panel')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({
      name: 'workspace_browser',
      description: '操作当前会话的隔离浏览器。create 创建标签页，list 获取真实 tabId，navigate/back/forward/reload/close 导航，screenshot 截图，cdp 调用此标签页的 DOM、Accessibility、Runtime、Input 方法。用户明确要求打开网页时，create 或 navigate 必须设置 reveal=true，以便展示对应标签；后台查资料不设置 reveal。已有标签也可通过 open_workspace_panel(panel=browser, tabId=真实标签ID) 展示。会话身份由 Host 绑定，禁止猜测其他会话或标签 ID。',
      parameters: {
        action: { type: 'string', enum: ['create', 'list', 'navigate', 'back', 'forward', 'reload', 'close', 'screenshot', 'cdp'], required: true },
        tabId: { type: 'string', description: 'list/create 返回的当前会话标签 ID' },
        url: { type: 'string', description: 'http/https 地址' },
        presentation: { type: 'string', description: '可选展示步骤标识；重复请求复用，仅真正的新展示步骤更换' },
        reveal: { type: 'boolean', description: '仅 create/navigate 使用；用户要求打开网页时设为 true，成功后请求展示目标标签。后台操作默认不展示。' },
        method: { type: 'string', description: 'CDP 方法，如 Runtime.evaluate、DOM.getDocument、Input.dispatchMouseEvent' },
        params: { type: 'string', description: 'CDP 参数 JSON 对象；Runtime.evaluate 可设置 awaitPromise 与 returnByValue' },
      },
      output: { schema: { type: 'string' }, render: (args, value) => args.action === 'screenshot'
        ? [{ type: 'image', attachment: JSON.parse(value) as ImageAttachmentRef }]
        : [{ type: 'text', text: value }] },
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('Browser requires an owning agent session')
        if (args.reveal && args.action !== 'create' && args.action !== 'navigate') throw new Error('reveal 仅适用于 create/navigate')
        const tabId = args.action === 'create' ? randomUUID() : args.tabId
        if (args.action === 'screenshot') {
          const result = JSON.parse(await this.browserCommand(exec.agent, { op: 'cdp', ...(tabId ? { tabId } : {}), method: 'Page.captureScreenshot', params: '{"format":"png"}' }, exec.signal)) as { data: string }
          const attachment = await this.ctx.attachments.saveImage({ data: Buffer.from(result.data, 'base64'), mediaType: 'image/png', name: 'browser.png' })
          return JSON.stringify(attachment)
        }
        const result = await this.browserCommand(exec.agent, { op: args.action, ...(tabId ? { tabId } : {}), ...(args.url ? { url: args.url } : args.action === 'create' ? { url: 'about:blank' } : {}), ...(args.method ? { method: args.method } : {}), ...(args.params ? { params: args.params } : {}) }, exec.signal)
        exec.signal.throwIfAborted()
        if (args.reveal) this.request(exec.agent, 'browser', tabId, undefined, args.presentation)
        return result
      },
    })), 'desktop-workspace: session browser tools')
    this.ctx.effect(() => this.ctx.root.on('api-session/removed', id => {
      this.requests.delete(String(id))
      this.turns.delete(String(id))
      this.changed()
      void desktopRequest('/v1/browser/command', { method: 'POST', body: JSON.stringify({ op: 'remove-session', sessionId: String(id) }) }).catch(error => this.ctx.logger.warn('Browser session cleanup failed: %s', String(error)))
    }), 'desktop-workspace: remove browser session')
  }

  request(agent: Agent, panel: WorkspacePanelRequest['panel'], tabId?: string, path?: string, presentation?: string): void {
    const sessionId = String(agent.session.id)
    const turn = this.turns.get(sessionId) ?? 0
    this.turns.set(sessionId, turn)
    this.requests.set(sessionId, { sessionId, panel, turn, ...(presentation ? { presentation } : {}), cwd: agent.session.header.cwd ?? '', revision: this.revision + 1, ...(panel === 'browser' && tabId ? { tabId } : {}), ...(path ? { path } : {}) })
    this.changed()
  }

  requestClose(agent: Agent): void {
    const sessionId = String(agent.session.id)
    const turn = this.turns.get(sessionId) ?? 0
    this.turns.set(sessionId, turn)
    this.requests.set(sessionId, { action: 'close', sessionId, turn, cwd: agent.session.header.cwd ?? '', revision: this.revision + 1 })
    this.changed()
  }

  @Remote('requests')
  pendingRequests(): WorkspacePresentationSnapshot {
    return { epoch: this.epoch, revision: this.revision, sessions: [...this.turns].map(([sessionId, turn]) => ({ sessionId, turn, request: this.requests.get(sessionId) ?? null })) }
  }

  private changed(): void {
    this.revision++
  }

  @Remote('browserCommand')
  async browserCommand(agent: Agent, request: BrowserCommand, signal: AbortSignal): Promise<string> {
    // Construct explicitly so a remote caller cannot smuggle a sessionId/Profile.
    const result = await desktopRequest<BrowserTab[] | BrowserTab | unknown>('/v1/browser/command', {
      method: 'POST', signal,
      body: JSON.stringify({ op: request.op, sessionId: String(agent.session.id), tabId: request.tabId, sequence: request.sequence, url: request.url, method: request.method, params: request.params ? JSON.parse(request.params) : undefined, visible: request.visible, bounds: request.bounds }),
    })
    return JSON.stringify(result)
  }

  constructor(ctx: Context) {
    super(ctx, 'desktopWorkspace')
  }

  @Remote('listDirectory')
  listDirectory(agent: Agent, directory: string, signal: AbortSignal): Promise<WorkspaceDirectorySnapshot> {
    return readWorkspaceDirectory(workspaceRoot(agent), directory, signal)
  }

  @Remote('search')
  search(agent: Agent, query: string, signal: AbortSignal): Promise<WorkspaceSearchSnapshot> {
    return searchWorkspace(workspaceRoot(agent), query, signal)
  }

  @Remote('readFile')
  readFile(agent: Agent, path: string, signal: AbortSignal): Promise<WorkspaceFileSnapshot> {
    return readWorkspaceFile(workspaceRoot(agent), path, signal)
  }

  @Remote('writeFile')
  writeFile(agent: Agent, request: WorkspaceFileWriteRequest, signal: AbortSignal): Promise<WorkspaceFileWriteResult> {
    return writeWorkspaceFile(workspaceRoot(agent), request, signal)
  }
}

export function workspaceRoot(agent: Agent): string {
  return resolve(agent.session.header.cwd ?? process.cwd())
}

export async function resolveWorkspaceFilePath(root: string, path: string): Promise<{ path: string; absolute: string }> {
  const canonical = await canonicalWorkspaceRoot(root)
  const normalized = normalizeWorkspaceInputPath(canonical, path)
  assertNotGitPath(normalized)
  return { path: normalized, absolute: await resolveInsideWorkspace(canonical, normalized, true) }
}

export async function readWorkspaceBinaryFile(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<{ readonly path: string; readonly data: Uint8Array }> {
  signal.throwIfAborted()
  const normalizedRoot = await canonicalWorkspaceRoot(root)
  const normalizedPath = normalizeWorkspaceInputPath(normalizedRoot, path)
  assertNotGitPath(normalizedPath)
  const absolute = await resolveInsideWorkspace(normalizedRoot, normalizedPath, false)
  const [data, info] = await Promise.all([readFile(absolute), stat(absolute)])
  signal.throwIfAborted()
  if (!info.isFile()) throw new Error('workspace path is not a file')
  if (data.length > DESIGN_BINARY_BYTE_CAP) throw new Error('design file exceeds the 64 MiB limit')
  return { path: normalizedPath, data }
}

export async function writeWorkspaceBinaryFile(
  root: string,
  path: string,
  data: Uint8Array,
  signal: AbortSignal,
): Promise<{ readonly path: string }> {
  signal.throwIfAborted()
  if (data.byteLength > DESIGN_BINARY_BYTE_CAP) throw new Error('design file exceeds the 64 MiB limit')
  const normalizedRoot = await canonicalWorkspaceRoot(root)
  const normalizedPath = normalizeWorkspaceInputPath(normalizedRoot, path)
  assertNotGitPath(normalizedPath)
  const absolute = await resolveInsideWorkspace(normalizedRoot, normalizedPath, true)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, data)
  signal.throwIfAborted()
  return { path: normalizedPath }
}

export async function readWorkspaceDirectory(
  root: string,
  directory: string,
  signal: AbortSignal,
): Promise<WorkspaceDirectorySnapshot> {
  signal.throwIfAborted()
  const normalizedRoot = await canonicalWorkspaceRoot(root)
  const normalizedDirectory = normalizeWorkspaceRelativePath(directory, true)
  const absolute = await resolveInsideWorkspace(normalizedRoot, normalizedDirectory, false)
  const entries = await readdir(absolute, { withFileTypes: true })
  signal.throwIfAborted()

  const visible = (await Promise.all(entries.map(async (entry): Promise<WorkspaceEntry | null> => {
    signal.throwIfAborted()
    if (CONTROL_CHARACTERS.test(entry.name)) return null
    if (entry.isDirectory() && TREE_SKIP_DIRECTORIES.has(entry.name)) return null
    if (!entry.isDirectory() && !entry.isFile()) return null
    const path = normalizedDirectory === '' ? entry.name : `${normalizedDirectory}/${entry.name}`
    if (entry.isDirectory()) return { name: entry.name, path, kind: 'directory', size: 0, mtime: 0 }
    try {
      const info = await stat(resolve(absolute, entry.name))
      return { name: entry.name, path, kind: 'file', size: info.size, mtime: info.mtimeMs }
    } catch {
      return { name: entry.name, path, kind: 'file', size: 0, mtime: 0 }
    }
  }))).filter((entry): entry is WorkspaceEntry => entry !== null)

  visible.sort((left, right) => kindRank(left.kind) - kindRank(right.kind) || compareText(left.name, right.name))
  return {
    rootName: basename(normalizedRoot) || normalizedRoot,
    directory: normalizedDirectory,
    entries: visible,
  }
}

export async function searchWorkspace(
  root: string,
  query: string,
  signal: AbortSignal,
): Promise<WorkspaceSearchSnapshot> {
  signal.throwIfAborted()
  const normalizedRoot = await canonicalWorkspaceRoot(root)
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return { query, hits: [], truncated: false }
  const hits: WorkspaceSearchHit[] = []
  let scanned = 0
  let truncated = false

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (truncated || depth > SEARCH_DEPTH_CAP) return
    signal.throwIfAborted()
    const absolute = await resolveInsideWorkspace(normalizedRoot, directory, false)
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      signal.throwIfAborted()
      if (scanned >= SEARCH_SCAN_CAP) {
        truncated = true
        return
      }
      scanned += 1
      if (CONTROL_CHARACTERS.test(entry.name)) continue
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().includes(needle)) continue
      if (hits.length >= SEARCH_HIT_CAP) {
        truncated = true
        return
      }
      hits.push({ name: entry.name, path, kind: 'file' })
    }
  }
  await walk('', 0)
  const rank = (hit: WorkspaceSearchHit): number => {
    const name = hit.name.toLocaleLowerCase()
    return name === needle ? 0 : name.startsWith(needle) ? 1 : 2
  }
  hits.sort((left, right) => rank(left) - rank(right) || left.path.length - right.path.length || compareText(left.path, right.path))
  return { query, hits, truncated }
}

export async function readWorkspaceFile(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<WorkspaceFileSnapshot> {
  signal.throwIfAborted()
  const normalizedRoot = await canonicalWorkspaceRoot(root)
  const normalizedPath = normalizeWorkspaceRelativePath(path)
  assertNotGitPath(normalizedPath)
  const absolute = await resolveInsideWorkspace(normalizedRoot, normalizedPath, false)
  const [data, info] = await Promise.all([readFile(absolute), stat(absolute)])
  signal.throwIfAborted()
  if (!info.isFile()) throw new Error('workspace path is not a file')
  const mediaType = mediaTypeOf(normalizedPath)
  const binary = isBinaryPreview(mediaType)
  if (binary && data.length > BINARY_BYTE_CAP) throw new Error('workspace file exceeds the preview limit')
  if (binary) {
    return {
      path: normalizedPath,
      content: `data:${mediaType};base64,${data.toString('base64')}`,
      encoding: 'data-url',
      mediaType,
      size: data.length,
      mtime: info.mtimeMs,
      truncated: false,
    }
  }
  const text = data.toString('utf8')
  return {
    path: normalizedPath,
    content: text.length > TEXT_CHARACTER_CAP ? text.slice(0, TEXT_CHARACTER_CAP) : text,
    encoding: 'utf8',
    mediaType,
    size: data.length,
    mtime: info.mtimeMs,
    truncated: text.length > TEXT_CHARACTER_CAP,
  }
}

export async function writeWorkspaceFile(
  root: string,
  request: WorkspaceFileWriteRequest,
  signal: AbortSignal,
): Promise<WorkspaceFileWriteResult> {
  signal.throwIfAborted()
  const normalizedRoot = await canonicalWorkspaceRoot(root)
  const normalizedPath = normalizeWorkspaceRelativePath(request.path)
  assertNotGitPath(normalizedPath)
  const absolute = await resolveInsideWorkspace(normalizedRoot, normalizedPath, true)
  let currentMtime = 0
  try {
    currentMtime = (await stat(absolute)).mtimeMs
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  if (request.baseMtime !== undefined && currentMtime !== 0 && Math.abs(currentMtime - request.baseMtime) > 1) {
    throw new Error('workspace file changed on disk since it was loaded')
  }
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, request.content, 'utf8')
  signal.throwIfAborted()
  return { path: normalizedPath, mtime: (await stat(absolute)).mtimeMs }
}

export function normalizeWorkspaceRelativePath(value: string, allowEmpty = false): string {
  if (CONTROL_CHARACTERS.test(value)) throw new Error('workspace path contains control characters')
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (normalized === '') {
    if (allowEmpty) return ''
    throw new Error('workspace path is empty')
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) throw new Error('workspace path must be relative')
  if (normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('workspace path contains an invalid segment')
  }
  return normalized
}

function normalizeWorkspaceInputPath(root: string, value: string): string {
  if (!isAbsolute(value)) return normalizeWorkspaceRelativePath(value)
  const fromRoot = relative(root, resolve(value))
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('workspace path escapes the active workspace')
  }
  return normalizeWorkspaceRelativePath(fromRoot)
}

async function canonicalWorkspaceRoot(root: string): Promise<string> {
  const normalized = resolve(root)
  const info = await lstat(normalized)
  if (!info.isDirectory()) throw new Error('active workspace is not a directory')
  return await realpath(normalized)
}

async function resolveInsideWorkspace(root: string, path: string, allowMissing: boolean): Promise<string> {
  const absolute = resolve(root, path === '' ? '.' : path)
  assertInside(root, absolute)
  let probe = absolute
  while (true) {
    try {
      const canonical = await realpath(probe)
      assertInside(root, canonical)
      return absolute
    } catch (error) {
      if (!allowMissing || !isNotFound(error)) throw error
      const parent = dirname(probe)
      if (parent === probe) throw error
      probe = parent
    }
  }
}

function assertInside(root: string, absolute: string): void {
  const fromRoot = relative(root, absolute)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('workspace path escapes the active workspace')
  }
}

function assertNotGitPath(path: string): void {
  if (path.split('/').some(segment => segment.toLocaleLowerCase() === '.git')) {
    throw new Error('workspace operation refuses to access .git')
  }
}

function mediaTypeOf(path: string): string {
  switch (extname(path).toLocaleLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.svg': return 'image/svg+xml'
    case '.bmp': return 'image/bmp'
    case '.ico': return 'image/x-icon'
    case '.avif': return 'image/avif'
    case '.pdf': return 'application/pdf'
    case '.html': case '.htm': return 'text/html'
    case '.md': case '.markdown': return 'text/markdown'
    case '.csv': return 'text/csv'
    case '.json': return 'application/json'
    default: return 'text/plain'
  }
}

function isBinaryPreview(mediaType: string): boolean {
  return mediaType.startsWith('image/') || mediaType === 'application/pdf'
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function kindRank(kind: WorkspaceEntry['kind']): number {
  return kind === 'directory' ? 0 : 1
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

export default WorkspaceGateway
