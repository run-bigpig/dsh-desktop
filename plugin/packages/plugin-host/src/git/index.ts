import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  GitDiffRequest,
  GitFileState,
  GitPathRequest,
  GitPathsRequest,
  GitSnapshot,
  GitCommitRequest,
} from '../shared/types.ts'
import { normalizeWorkspaceRelativePath } from '../workspace/index.ts'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024

/** Human-only system Git gateway. No methods are registered as Agent Tools. */
export class DesktopGitGateway extends TypertRemoteService {
  private availability: boolean | undefined

  constructor(ctx: Context) {
    super(ctx, 'desktopGit')
  }

  @Remote('snapshot')
  async snapshot(agent: Agent, signal: AbortSignal): Promise<GitSnapshot> {
    const root = resolve(agent.session.header.cwd ?? process.cwd())
    if (!await this.gitAvailable(signal)) return unavailableSnapshot()
    if (!await isRepository(root, signal)) return { available: true, repository: false, branch: null, files: [] }
    const [branch, status] = await Promise.all([
      runGit(root, ['branch', '--show-current'], signal),
      runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
    ])
    return {
      available: true,
      repository: true,
      branch: branch.stdout.trim() || null,
      files: parsePorcelainStatus(status.stdout),
    }
  }

  @Remote('diff')
  async diff(agent: Agent, request: GitDiffRequest, signal: AbortSignal): Promise<string> {
    const root = resolve(agent.session.header.cwd ?? process.cwd())
    await requireRepository(root, signal, () => this.gitAvailable(signal))
    const path = normalizeWorkspaceRelativePath(request.path)
    const tracked = await isTracked(root, path, signal)
    if (!tracked) return (await runGitDiff(root, ['diff', '--no-index', '--no-color', '--', '/dev/null', path], signal)).stdout
    const args = ['diff', '--no-ext-diff', '--no-color']
    if (request.staged) args.push('--cached')
    args.push('--', path)
    return (await runGit(root, args, signal)).stdout
  }

  @Remote('stage')
  async stage(agent: Agent, request: GitPathRequest, signal: AbortSignal): Promise<GitSnapshot> {
    const root = resolve(agent.session.header.cwd ?? process.cwd())
    await requireRepository(root, signal, () => this.gitAvailable(signal))
    await runGit(root, ['add', '--', normalizeWorkspaceRelativePath(request.path)], signal)
    return await this.snapshot(agent, signal)
  }

  @Remote('stageMany')
  async stageMany(agent: Agent, request: GitPathsRequest, signal: AbortSignal): Promise<GitSnapshot> {
    const root = resolve(agent.session.header.cwd ?? process.cwd())
    await requireRepository(root, signal, () => this.gitAvailable(signal))
    const paths = normalizeGitPaths(request.paths)
    if (paths.length !== 0) await runGit(root, ['add', '--', ...paths], signal)
    return await this.snapshot(agent, signal)
  }

  @Remote('unstage')
  async unstage(agent: Agent, request: GitPathRequest, signal: AbortSignal): Promise<GitSnapshot> {
    const root = resolve(agent.session.header.cwd ?? process.cwd())
    await requireRepository(root, signal, () => this.gitAvailable(signal))
    const path = normalizeWorkspaceRelativePath(request.path)
    try {
      await runGit(root, ['restore', '--staged', '--', path], signal)
    } catch (error) {
      if (!isUnbornHeadError(error)) throw error
      await runGit(root, ['rm', '--cached', '-q', '--', path], signal)
    }
    return await this.snapshot(agent, signal)
  }

  @Remote('unstageMany')
  async unstageMany(agent: Agent, request: GitPathsRequest, signal: AbortSignal): Promise<GitSnapshot> {
    const root = resolve(agent.session.header.cwd ?? process.cwd())
    await requireRepository(root, signal, () => this.gitAvailable(signal))
    const paths = normalizeGitPaths(request.paths)
    if (paths.length !== 0) {
      try {
        await runGit(root, ['restore', '--staged', '--', ...paths], signal)
      } catch (error) {
        if (!isUnbornHeadError(error)) throw error
        await runGit(root, ['rm', '--cached', '-q', '--', ...paths], signal)
      }
    }
    return await this.snapshot(agent, signal)
  }

  @Remote('discard')
  async discard(agent: Agent, request: GitPathsRequest, signal: AbortSignal): Promise<GitSnapshot> {
    const root = resolve(agent.session.header.cwd ?? process.cwd())
    await requireRepository(root, signal, () => this.gitAvailable(signal))
    await discardGitPaths(root, normalizeGitPaths(request.paths), signal)
    return await this.snapshot(agent, signal)
  }

  @Remote('commit')
  async commit(agent: Agent, request: GitCommitRequest, signal: AbortSignal): Promise<GitSnapshot> {
    const root = resolve(agent.session.header.cwd ?? process.cwd())
    await requireRepository(root, signal, () => this.gitAvailable(signal))
    const message = request.message.trim()
    if (message.length === 0) throw new Error('commit message is empty')
    if (message.length > 10_000) throw new Error('commit message is too long')
    await runGit(root, ['commit', '-m', message], signal)
    return await this.snapshot(agent, signal)
  }

  private async gitAvailable(signal: AbortSignal): Promise<boolean> {
    if (this.availability !== undefined) return this.availability
    const available = await detectSystemGit(signal)
    this.availability = available
    return available
  }
}

export function parsePorcelainStatus(value: string): GitFileState[] {
  const records = value.split('\0')
  const files: GitFileState[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record.length < 4) continue
    const indexState = record[0] ?? ' '
    const worktreeState = record[1] ?? ' '
    const path = record.slice(3)
    if (path.length === 0) continue
    const renamed = indexState === 'R' || indexState === 'C' || worktreeState === 'R' || worktreeState === 'C'
    const fromPath = renamed ? records[index + 1] : undefined
    if (renamed && fromPath !== undefined) index += 1
    files.push({
      path,
      index: indexState,
      worktree: worktreeState,
      ...(fromPath === undefined || fromPath === '' ? {} : { fromPath }),
    })
  }
  return files
}

export function normalizeGitError(error: unknown): Error {
  if (typeof error !== 'object' || error === null) return new Error(String(error))
  const record = error as { code?: unknown; stderr?: unknown; message?: unknown }
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : ''
  if (stderr !== '') return new Error(stderr)
  if (typeof record.message === 'string' && record.message !== '') return new Error(record.message)
  return new Error(`git failed${record.code === undefined ? '' : ` (${String(record.code)})`}`)
}

export async function discardGitPaths(root: string, paths: readonly string[], signal: AbortSignal): Promise<void> {
  const repository = (await runGit(root, ['rev-parse', '--show-toplevel'], signal)).stdout.trim()
  if (repository === '') throw new Error('active workspace is not a Git repository')
  for (const path of paths) {
    signal.throwIfAborted()
    const normalized = normalizeWorkspaceRelativePath(path)
    const absolute = resolve(root, normalized)
    assertInsideRepository(root, absolute)
    if (!await isTracked(root, normalized, signal)) {
      await rm(absolute, { recursive: true, force: true })
      continue
    }
    await runGit(root, ['restore', '--worktree', '--', normalized], signal)
  }
}

function normalizeGitPaths(paths: readonly string[]): string[] {
  if (paths.length > 2_000) throw new Error('too many Git paths')
  return [...new Set(paths.map(path => normalizeWorkspaceRelativePath(path)))]
}

async function isTracked(root: string, path: string, signal: AbortSignal): Promise<boolean> {
  try {
    await runGit(root, ['ls-files', '--error-unmatch', '--', path], signal)
    return true
  } catch {
    return false
  }
}

function assertInsideRepository(root: string, path: string): void {
  const fromRoot = relative(root, path)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Git path escapes the repository')
  }
}

async function detectSystemGit(signal: AbortSignal): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], gitOptions(signal))
    return true
  } catch (error) {
    if (isMissingExecutable(error)) return false
    throw normalizeGitError(error)
  }
}

async function isRepository(root: string, signal: AbortSignal): Promise<boolean> {
  try {
    const result = await runGit(root, ['rev-parse', '--is-inside-work-tree'], signal)
    return result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function requireRepository(
  root: string,
  signal: AbortSignal,
  available: () => Promise<boolean>,
): Promise<void> {
  if (!await available()) throw new Error('system Git is unavailable')
  if (!await isRepository(root, signal)) throw new Error('active workspace is not a Git repository')
}

async function runGit(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], gitOptions(signal))
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    throw normalizeGitError(error)
  }
}

async function runGitDiff(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], gitOptions(signal))
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1 && 'stdout' in error) {
      const result = error as { stdout?: unknown; stderr?: unknown }
      return {
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
      }
    }
    throw normalizeGitError(error)
  }
}

function gitOptions(signal: AbortSignal) {
  return {
    encoding: 'utf8' as const,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    signal,
    windowsHide: true,
  }
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isUnbornHeadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /(?:could not resolve HEAD|ambiguous argument ['"]?HEAD|unknown revision.*HEAD)/iu.test(error.message)
}

function unavailableSnapshot(): GitSnapshot {
  return { available: false, repository: false, branch: null, files: [] }
}

export default DesktopGitGateway
