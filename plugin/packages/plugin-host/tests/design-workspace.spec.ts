import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceDesignFiles, validateWorkspaceDesign } from '../src/design/workspace-files.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'starweave-design-workspace-'))
  roots.push(root)
  const workspace = join(root, 'project')
  await mkdir(workspace)
  const state = join(root, 'state')
  return { root, workspace, state, owner: { id: 'chat-a', workspace: () => workspace }, files: createWorkspaceDesignFiles(state) }
}

describe('workspace design files', () => {
  it('persists one default design per chat and workspace across restarts', async () => {
    const { owner, state, files } = await fixture()
    const [first, concurrent] = await Promise.all([files.select(owner), files.select(owner)])
    expect(concurrent).toEqual(first)
    expect(first.path).toMatch(/^designs\/Untitled-[0-9a-f-]+\.fig$/)
    expect(await files.select(owner)).toEqual(first)
    expect(await createWorkspaceDesignFiles(state).select(owner)).toEqual(first)
    const second = await files.select(owner, undefined, true)
    expect(second.id).not.toBe(first.id)
    expect(await files.select(owner)).toEqual(second)
    await expect(files.select({ ...owner, id: 'chat-b' }, first.id)).rejects.toThrow('does not belong')
  })

  it('keeps existing documents in their original workspace after switching', async () => {
    const { owner, root, files } = await fixture()
    const first = await files.select(owner)
    const other = join(root, 'other')
    await mkdir(other)
    const switched = { ...owner, workspace: () => other }
    expect(await files.select(switched, first.id)).toEqual(first)
    expect((await files.select(switched)).root).toBe(await realpath(other))
  })

  it('opens an existing relative file without changing its bytes', async () => {
    const { workspace, owner, files } = await fixture()
    await mkdir(join(workspace, 'designs'))
    const path = join(workspace, 'designs', 'Landing.fig')
    await writeFile(path, 'existing design')
    const opened = await files.open(owner, 'designs/Landing.fig')
    expect(await files.open(owner, 'designs/Landing.fig')).toEqual(opened)
    await expect(files.open({ ...owner, id: 'chat-b' }, 'designs/Landing.fig')).rejects.toThrow('belongs to another chat')
    expect(await readFile(path, 'utf8')).toBe('existing design')
  })

  it.each(['../escape.fig', '/outside.fig', 'designs/file.fig:stream', 'designs/../file.fig', '.git/file.fig', 'designs\\file.fig'])('rejects unsafe path %s', async path => {
    const { files, owner } = await fixture()
    await expect(files.open(owner, path)).rejects.toThrow()
  })

  it('rejects directory junctions escaping the workspace', async () => {
    const { root, workspace, owner, files } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(workspace, 'designs'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(files.select(owner)).rejects.toThrow('symlinks or junctions')
  })

  it('rechecks the path if a directory is replaced after selection', async () => {
    const { root, workspace, owner, files } = await fixture()
    const document = await files.select(owner)
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(workspace, 'designs'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(validateWorkspaceDesign(document)).rejects.toThrow('symlinks or junctions')
  })

  it('does not fall back to the process directory when no workspace is selected', async () => {
    const { files } = await fixture()
    await expect(files.select({ id: 'chat', workspace: () => undefined })).rejects.toThrow('Select a workspace')
  })
})
