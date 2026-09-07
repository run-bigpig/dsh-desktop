import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceDesignStore } from '../src/design/workspace-store.ts'
import { createDesignDocumentStore } from '../src/design/storage.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-workspace-'))
  roots.push(root)
  const recovery = join(root, 'private', 'session.json')
  return { root, recovery, store: new WorkspaceDesignStore(root, recovery) }
}
const data = (value: string) => Buffer.from(value).toString('base64')
function save(store: WorkspaceDesignStore, value: string) {
  return store.save({ name: 'test.fig', data: data(value), binding: { ...store.currentBinding()! } })
}

it('saves actual file bytes and reopens independent files in one session', async () => {
  const { root, store, recovery } = await fixture()
  await store.select('first.fig', true)
  await save(store, 'first')
  const old = { name: 'first.fig', data: data('stale'), binding: { ...store.currentBinding()! } }
  await store.select('second.fig', true)
  await save(store, 'second')
  await expect(store.save(old)).rejects.toThrow('旧文档')
  expect(await readFile(join(root, 'first.fig'), 'utf8')).toBe('first')
  expect(await readFile(join(root, 'second.fig'), 'utf8')).toBe('second')
  expect((await store.select('first.fig', false))?.data).toBe(data('first'))
  await save(store, 'first edited')
  const restarted = new WorkspaceDesignStore(root, recovery)
  expect((await restarted.load())?.data).toBe(data('first edited'))
  expect(restarted.currentBinding()?.path).toBe('first.fig')
})

it('preserves external changes and retains recovery bytes after refusing a stale save', async () => {
  const { root, store, recovery } = await fixture()
  await store.select('design.fig', true)
  await save(store, 'original')
  await writeFile(join(root, 'design.fig'), 'external')
  await expect(save(store, 'local edit')).rejects.toThrow('其他编辑器修改')
  expect(await readFile(join(root, 'design.fig'), 'utf8')).toBe('external')
  expect((await createDesignDocumentStore(recovery).load())?.data).toBe(data('local edit'))
  const restarted = new WorkspaceDesignStore(root, recovery)
  expect((await restarted.load())?.data).toBe(data('external'))
})

it('serializes competing sessions and rejects the session based on an older disk version', async () => {
  const { root, store } = await fixture()
  await store.select('shared.fig', true)
  await save(store, 'base')
  const other = new WorkspaceDesignStore(root, join(root, 'private', 'other.json'))
  await other.select('shared.fig', false)
  const results = await Promise.allSettled([save(store, 'first'), save(other, 'second')])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
})

it('migrates a legacy snapshot into a unique file and refuses existing targets or workspace escape', async () => {
  const { root, store, recovery } = await fixture()
  await createDesignDocumentStore(recovery).save({ name: 'legacy.fig', data: data('legacy') })
  const document = await store.load()
  await store.save(document!)
  expect(await readFile(join(root, store.artifact().path), 'utf8')).toBe('legacy')
  await expect(store.select(store.artifact().path, true)).rejects.toThrow('已存在')
  await expect(store.select('../outside.fig', true)).rejects.toThrow()
  await expect(store.select('.git/inside.fig', true)).rejects.toThrow()
  await expect(store.select('not-a-design.txt', true)).rejects.toThrow('.fig')
})

it('never reports an unsaved new design as a completed artifact', async () => {
  const { store } = await fixture()
  await store.select('new.fig', true)
  expect(() => store.artifact()).toThrow('尚未成功保存')
})

it('remembers a reopened file without rewriting its bytes', async () => {
  const { root, store, recovery } = await fixture()
  await writeFile(join(root, 'original.fig'), 'external original')
  const document = await store.select('original.fig', false)
  await store.remember(document!)
  expect(await readFile(join(root, 'original.fig'), 'utf8')).toBe('external original')
  const restarted = new WorkspaceDesignStore(root, recovery)
  expect((await restarted.load())?.data).toBe(data('external original'))
  expect(restarted.currentBinding()?.path).toBe('original.fig')
})

it('restores uncommitted recovery edits as unsaved while the base disk file is unchanged', async () => {
  const { root, store, recovery } = await fixture()
  await store.select('recovery.fig', true)
  await save(store, 'disk')
  await createDesignDocumentStore(recovery).save({ name: 'recovery.fig', data: data('uncommitted'), binding: { ...store.currentBinding()! } })
  const restored = await new WorkspaceDesignStore(root, recovery).load()
  expect(restored).toMatchObject({ data: data('uncommitted'), unsaved: true })
  expect(await readFile(join(root, 'recovery.fig'), 'utf8')).toBe('disk')
})
