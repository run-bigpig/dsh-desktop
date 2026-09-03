import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readWorkspaceBinaryFile, readWorkspaceDirectory, readWorkspaceFile, searchWorkspace,
  writeWorkspaceBinaryFile, writeWorkspaceFile,
} from '../src/workspace.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-'))
  temporaryDirectories.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'README.md'), '# test\n')
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
  return root
}

describe('workspace directory browser', () => {
  it('lists directories before files with workspace-relative paths', async () => {
    const root = await workspace()
    const snapshot = await readWorkspaceDirectory(root, '', new AbortController().signal)

    expect(snapshot.rootName).toBe(basename(root))
    expect(snapshot.entries).toEqual([
      { name: 'src', path: 'src', kind: 'directory', size: 0, mtime: 0 },
      expect.objectContaining({ name: 'README.md', path: 'README.md', kind: 'file', size: 7 }),
    ])
    await expect(readWorkspaceDirectory(root, 'src', new AbortController().signal)).resolves.toMatchObject({
      directory: 'src',
      entries: [expect.objectContaining({ name: 'index.ts', path: 'src/index.ts', kind: 'file' })],
    })
  })

  it('rejects absolute and escaping paths', async () => {
    const root = await workspace()
    await expect(readWorkspaceDirectory(root, '../outside', new AbortController().signal)).rejects.toThrow('invalid segment')
    await expect(readWorkspaceDirectory(root, '/outside', new AbortController().signal)).rejects.toThrow('must be relative')
  })

  it('searches filenames while pruning dependency and Git directories', async () => {
    const root = await workspace()
    await mkdir(join(root, 'node_modules', 'hidden'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'hidden', 'index.ts'), '')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'index.ts'), '')

    await expect(searchWorkspace(root, 'index', new AbortController().signal)).resolves.toEqual({
      query: 'index',
      hits: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }],
      truncated: false,
    })
  })

  it('reads and writes text with an mtime conflict guard', async () => {
    const root = await workspace()
    const signal = new AbortController().signal
    const first = await readWorkspaceFile(root, 'README.md', signal)
    expect(first).toMatchObject({ content: '# test\n', encoding: 'utf8', mediaType: 'text/markdown' })
    const saved = await writeWorkspaceFile(root, {
      path: 'README.md', content: '# changed\n', baseMtime: first.mtime,
    }, signal)
    expect(saved.mtime).toBeGreaterThan(0)
    await writeFile(join(root, 'README.md'), '# external\n')
    const future = new Date(Date.now() + 5_000)
    await utimes(join(root, 'README.md'), future, future)
    await expect(writeWorkspaceFile(root, {
      path: 'README.md', content: '# stale\n', baseMtime: first.mtime,
    }, signal)).rejects.toThrow('changed on disk')
  })

  it('reads and writes design binaries only inside the workspace', async () => {
    const root = await workspace()
    const signal = new AbortController().signal
    const data = new Uint8Array([0x66, 0x69, 0x67])
    await expect(writeWorkspaceBinaryFile(root, 'designs/home.fig', data, signal)).resolves.toEqual({
      path: 'designs/home.fig',
    })
    const saved = await readWorkspaceBinaryFile(root, 'designs/home.fig', signal)
    expect(saved.path).toBe('designs/home.fig')
    expect([...saved.data]).toEqual([...data])
    await expect(writeWorkspaceBinaryFile(root, '../outside.fig', data, signal)).rejects.toThrow('invalid segment')
    await expect(writeWorkspaceBinaryFile(root, '.git/design.fig', data, signal)).rejects.toThrow('.git')
  })

  it('rejects design files larger than 64 MiB', async () => {
    const root = await workspace()
    const data = new Uint8Array(64 * 1024 * 1024 + 1)
    await expect(writeWorkspaceBinaryFile(
      root, 'oversized.fig', data, new AbortController().signal,
    )).rejects.toThrow('64 MiB')
  })
})
