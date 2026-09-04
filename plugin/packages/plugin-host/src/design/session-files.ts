import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, resolve } from 'node:path'

const STATE_FILE = 'design-sessions.json'

type SessionFileState = {
  schemaVersion: 1
  sessions: Record<string, { path: string }>
}

export function createDesignSessionFiles(root = process.env.STARWEAVE_DESIGN_STATE_DIR) {
  const statePath = root ? resolve(root, STATE_FILE) : undefined
  let statePromise: Promise<SessionFileState> | undefined
  let writeChain = Promise.resolve()

  async function load(): Promise<SessionFileState> {
    if (!statePath) return emptyState()
    if (!statePromise) {
      statePromise = readFile(statePath, 'utf8')
        .then(value => parseState(JSON.parse(value) as unknown))
        .catch(() => emptyState())
    }
    return await statePromise
  }

  async function get(sessionId: string): Promise<string | undefined> {
    const path = (await load()).sessions[sessionId]?.path
    if (!path || !isAbsolute(path) || extname(path).toLowerCase() !== '.fig') return undefined
    try {
      return (await stat(path)).isFile() ? path : undefined
    } catch {
      return undefined
    }
  }

  async function set(sessionId: string, path: string): Promise<void> {
    if (!statePath) return
    if (!isAbsolute(path) || extname(path).toLowerCase() !== '.fig') {
      throw new Error('StarWeave Design session path must be an absolute .fig path')
    }
    writeChain = writeChain.catch(() => undefined).then(async () => {
      const state = await load()
      state.sessions[sessionId] = { path }
      await mkdir(dirname(statePath), { recursive: true })
      const temporary = `${statePath}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, statePath)
    })
    await writeChain
  }

  return { get, set }
}

function emptyState(): SessionFileState {
  return { schemaVersion: 1, sessions: {} }
}

function parseState(value: unknown): SessionFileState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.sessions)) return emptyState()
  const sessions: SessionFileState['sessions'] = {}
  for (const [sessionId, entry] of Object.entries(value.sessions)) {
    if (isRecord(entry) && typeof entry.path === 'string') sessions[sessionId] = { path: entry.path }
  }
  return { schemaVersion: 1, sessions }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
