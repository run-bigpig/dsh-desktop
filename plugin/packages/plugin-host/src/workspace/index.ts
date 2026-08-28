import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
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

/** Human-only file browser and preview gateway for the active Session workspace. */
export class WorkspaceGateway extends TypertRemoteService {
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

function workspaceRoot(agent: Agent): string {
  return resolve(agent.session.header.cwd ?? process.cwd())
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
