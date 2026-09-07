import type { Context } from '@deepseek-ai/cordis'
import type { DesktopWorkspaceRemote, DesignRemote } from '../index.ts'
import type { ArtifactResultTailInjected } from '../design/CanvasResultTail.tsx'
import type { WorkbenchController } from './session-state.ts'

export const resourceOpenerInject = ['remote.desktopWorkspace', 'remote.starweaveDesign', 'sessions']

/** Callers register their UI in the same injected scope that owns these actions. */
export function createResourceOpeners(ctx: Context, controller: WorkbenchController): Pick<ArtifactResultTailInjected, 'openCanvasFile' | 'openBrowserPage'> {
  const services = ctx as Context & { 'remote.desktopWorkspace': DesktopWorkspaceRemote; 'remote.starweaveDesign': DesignRemote }
  const workspace = services['remote.desktopWorkspace']
  const design = services['remote.starweaveDesign']
  const sessions = ctx.sessions
  let active = true
  ctx.effect(() => () => { active = false }, 'desktop-workspace: stop resource openers')
  return {
    openCanvasFile: async (sessionId, path, reloadFromDisk = false) => {
      if (!active) return
      const interactions = controller.captureInteractions()
      unwrap(await design.openFile(sessionId, { path, reloadFromDisk }, AbortSignal.timeout(120_000)))
      if (active) controller.openCanvasFile(sessionId, interactions)
    },
    openBrowserPage: async (sessionId, page) => {
      if (!active) return
      const interactions = controller.captureInteractions()
      const tabs = JSON.parse(unwrap(await workspace.browserCommand(sessionId, { op: 'list' }, AbortSignal.timeout(10_000)))) as Array<{ id: string }>
      if (!active) return
      let tabId = page.id
      if (!tabs.some(tab => tab.id === tabId)) {
        tabId = crypto.randomUUID()
        unwrap(await workspace.browserCommand(sessionId, { op: 'create', tabId, url: page.url }, AbortSignal.timeout(30_000)))
      }
      if (!active) return
      const cwd = Object.entries(sessions.list.getSnapshot().byId).find(([id]) => id === sessionId)?.[1]?.cwd ?? ''
      controller.openBrowserPage(sessionId, cwd, tabId, interactions)
    },
  }
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
