import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export type DesignOwner = { id: string; workspace: () => string | undefined }
export type WorkspaceDesign = { id: string; owner: string; root: string; path: string; saved?: boolean }
type State = { documents: Record<string, WorkspaceDesign>; latest: Record<string, string> }

export function resolveWorkspaceDesignStateRoot(
  explicit = process.env.STARWEAVE_DESIGN_STATE_DIR,
  harnessHome = process.env.DSH_HOME
): string {
  if (explicit?.trim()) return resolve(explicit)
  if (harnessHome?.trim()) return resolve(harnessHome, 'starweave-design')
  throw new Error('StarWeave Design requires DSH_HOME when no persistence directory override is configured')
}

export function createWorkspaceDesignFiles(stateRoot = resolveWorkspaceDesignStateRoot()) {
  let state: Promise<State> | undefined
  let tail = Promise.resolve()
  let selectionTail = Promise.resolve()
  const stateFile = resolve(stateRoot, 'workspace-designs.json')

  async function load(): Promise<State> {
    return state ??= readFile(stateFile, 'utf8').then(text => {
      const parsed = JSON.parse(text) as State & { schemaVersion: number }
      if (parsed.schemaVersion !== 1 || !parsed.documents || !parsed.latest) {
        throw new Error('Invalid workspace design index')
      }
      return parsed
    }).catch(error => {
      if (error.code === 'ENOENT') return { documents: {}, latest: {} }
      throw error
    })
  }

  async function rootFor(owner: DesignOwner): Promise<string> {
    const root = owner.workspace()
    if (!root || !isAbsolute(root)) throw new Error('Select a workspace before creating a design')
    if (!(await stat(root)).isDirectory()) throw new Error('Design workspace is not a directory')
    return await realpath(root)
  }

  async function persist(change: (next: State) => void): Promise<void> {
    const operation = tail.catch(() => undefined).then(async () => {
      const current = await load()
      const next = { documents: { ...current.documents }, latest: { ...current.latest } }
      change(next)
      await mkdir(dirname(stateFile), { recursive: true })
      const temporary = `${stateFile}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...next }), { mode: 0o600 })
        await rename(temporary, stateFile!)
      } finally { await rm(temporary, { force: true }) }
      state = Promise.resolve(next)
    })
    tail = operation
    await operation
  }

  async function select(owner: DesignOwner, requested?: string, fresh = false): Promise<WorkspaceDesign> {
    const current = await load()
    if (requested) {
      const found = current.documents[requested]
      if (!found || found.owner !== owner.id) throw new Error('Design document does not belong to this session')
      await validateWorkspaceDesign(found)
      return found
    }
    const root = await rootFor(owner)
    const key = JSON.stringify([owner.id, root])
    const id = !fresh ? current.latest[key] : undefined
    if (id) {
      const found = current.documents[id]
      if (!found || found.owner !== owner.id) throw new Error('Design document does not belong to this session')
      await validateWorkspaceDesign(found)
      return found
    }
    const documentId = randomUUID()
    const document = { id: documentId, owner: owner.id, root, path: `designs/Untitled-${documentId}.fig` }
    await validateWorkspaceDesign(document)
    await persist(next => {
      next.documents[document.id] = document
      next.latest[key] = document.id
    })
    return document
  }

  async function open(owner: DesignOwner, path: string): Promise<WorkspaceDesign> {
    const root = await rootFor(owner)
    const document = { id: randomUUID(), owner: owner.id, root, path, saved: true }
    const absolute = await validateWorkspaceDesign(document)
    if (!(await stat(absolute)).isFile()) throw new Error('Design file does not exist')
    const current = await load()
    const samePath = Object.values(current.documents).find(entry =>
      (process.platform === 'win32' ? `${entry.root}/${entry.path}`.toLowerCase() : `${entry.root}/${entry.path}`) ===
      (process.platform === 'win32' ? `${root}/${path}`.toLowerCase() : `${root}/${path}`)
    )
    if (samePath && samePath.owner !== owner.id) throw new Error('Design file belongs to another chat; open a separate copy')
    const existing = Object.values(current.documents).find(entry => entry.owner === owner.id && entry.root === root && entry.path === path)
    const selected = existing ?? document
    await persist(next => {
      next.documents[selected.id] = selected
      next.latest[JSON.stringify([owner.id, root])] = selected.id
    })
    return selected
  }

  async function markSaved(document: WorkspaceDesign) {
    if (document.saved) return
    await persist(next => { next.documents[document.id] = { ...document, saved: true } })
    document.saved = true
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = selectionTail.catch(() => undefined).then(operation)
    selectionTail = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    select: (owner: DesignOwner, requested?: string, fresh = false) => serialize(() => select(owner, requested, fresh)),
    open: (owner: DesignOwner, path: string) => serialize(() => open(owner, path)),
    markSaved
  }
}

/** Reject traversal, alternate streams, and symlink/junction escapes, including missing targets. */
export async function validateWorkspaceDesign(document: WorkspaceDesign): Promise<string> {
  const { root, path } = document
  if (!isAbsolute(root) || !path.toLowerCase().endsWith('.fig') || /[\\:<>"|?*\u0000-\u001f]/u.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error('Design path must be a workspace-relative .fig file')
  }
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== root) throw new Error('Design workspace changed on disk')
  const target = resolve(root, path)
  const inside = relative(root, target)
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Design path escapes workspace')
  let probe = root
  for (const part of path.split('/')) {
    probe = resolve(probe, part)
    try {
      if ((await lstat(probe)).isSymbolicLink()) throw new Error('Design paths cannot contain symlinks or junctions')
      const actual = await realpath(probe)
      const relativePath = relative(root, actual)
      if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('Design path escapes workspace')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      break
    }
  }
  return target
}
