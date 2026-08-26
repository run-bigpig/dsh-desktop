import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { discardGitPaths, normalizeGitError, parsePorcelainStatus } from '../src/git.ts'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('desktop Git gateway', () => {
  it('parses staged, unstaged, untracked, and renamed porcelain records', () => {
    expect(parsePorcelainStatus([
      'M  staged.ts',
      ' M unstaged.ts',
      '?? new.ts',
      'R  renamed.ts',
      'old.ts',
      '',
    ].join('\0'))).toEqual([
      { path: 'staged.ts', index: 'M', worktree: ' ' },
      { path: 'unstaged.ts', index: ' ', worktree: 'M' },
      { path: 'new.ts', index: '?', worktree: '?' },
      { path: 'renamed.ts', fromPath: 'old.ts', index: 'R', worktree: ' ' },
    ])
  })

  it('prefers Git stderr when surfacing a command failure', () => {
    expect(normalizeGitError({ message: 'wrapper failed', stderr: 'fatal: not a git repository\n' }).message)
      .toBe('fatal: not a git repository')
  })

  it('restores tracked files and deletes untracked files when discard is confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-git-'))
    temporaryDirectories.push(root)
    await execFileAsync('git', ['init'], { cwd: root })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'base\n')
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root })
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    await writeFile(join(root, 'new.txt'), 'new\n')

    await discardGitPaths(root, ['tracked.txt', 'new.txt'], new AbortController().signal)

    await expect(readFile(join(root, 'tracked.txt'), 'utf8')).resolves.toBe('base\n')
    await expect(readFile(join(root, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
