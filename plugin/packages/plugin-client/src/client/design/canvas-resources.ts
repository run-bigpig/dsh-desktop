import type { DesignConnection } from '@run-bigpig/dsh-desktop-plugin-host/types'

type EmbedHandle = { unmount: () => void; present: (signal: AbortSignal) => Promise<void> }
type EmbedAPI = { mount: (element: HTMLElement, connection: DesignConnection) => Promise<EmbedHandle> }
interface CanvasResource {
  readonly host: HTMLDivElement
  readonly ready: Promise<void>
  handle?: EmbedHandle
  disposed: boolean
  cancelStyle: () => void
}

/** Keep the editor and its renderer alive while the official details seat remounts. */
export class CanvasResources {
  private readonly sessions = new Map<string, CanvasResource>()
  private readonly modules = new Map<string, Promise<EmbedAPI>>()

  constructor(private readonly load: (src: string) => Promise<EmbedAPI> = src => import(/* @vite-ignore */ src)) {}

  ensure(connection: DesignConnection): CanvasResource {
    const existing = this.sessions.get(connection.sessionId)
    if (existing) return existing
    const base = new URL(connection.baseUrl)
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('画布返回了无效的本地地址')
    const host = document.createElement('div')
    host.dataset.starweaveCanvasSession = connection.sessionId
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('link')
    style.rel = 'stylesheet'
    style.href = new URL(connection.stylePath, base).href
    let cancelStyle!: () => void
    const styled = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        style.onload = style.onerror = null
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('画布样式加载超时，请重试')), 15_000)
      style.onload = () => finish()
      style.onerror = () => finish(new Error('画布样式加载失败，请重试'))
      cancelStyle = () => finish()
    })
    const surface = document.createElement('div')
    surface.style.cssText = 'width:100%;height:100%'
    shadow.append(style, surface)
    const src = new URL(connection.scriptPath, base).href
    let module = this.modules.get(src)
    if (!module) {
      module = this.load(src).then((api: EmbedAPI) => {
        if (typeof api.mount !== 'function') throw new Error('画布模块未完成初始化')
        return api
      }).catch(error => { this.modules.delete(src); throw error })
      this.modules.set(src, module)
    }
    const resource: CanvasResource = {
      host, disposed: false, cancelStyle,
      ready: Promise.all([module, styled]).then(async ([api]) => {
        if (resource.disposed) return
        const handle = await api.mount(surface, connection)
        if (resource.disposed) handle.unmount()
        else resource.handle = handle
      }).catch(error => { this.remove(connection.sessionId); throw error }),
    }
    this.sessions.set(connection.sessionId, resource)
    this.park(resource)
    return resource
  }

  attach(connection: DesignConnection, target: HTMLElement): { ready: Promise<void>; detach: () => void } {
    const resource = this.ensure(connection)
    const abort = new AbortController()
    resource.host.style.cssText = 'width:100%;height:100%;min-height:0'
    resource.host.inert = false
    resource.host.removeAttribute('aria-hidden')
    target.append(resource.host)
    return { ready: resource.ready.then(async () => {
      abort.signal.throwIfAborted()
      if (!resource.disposed) await resource.handle!.present(abort.signal)
    }), detach: () => {
      abort.abort()
      if (!resource.disposed && resource.host.parentElement === target) this.park(resource)
    } }
  }

  remove(sessionId: string): void {
    const resource = this.sessions.get(sessionId)
    if (!resource) return
    resource.disposed = true
    resource.cancelStyle()
    resource.handle?.unmount()
    resource.host.remove()
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    for (const id of this.sessions.keys()) this.remove(id)
    this.modules.clear()
  }

  private park(resource: CanvasResource): void {
    // Offscreen with real dimensions: display:none would destroy renderer geometry.
    resource.host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:800px;pointer-events:none;overflow:hidden'
    resource.host.inert = true
    resource.host.setAttribute('aria-hidden', 'true')
    document.body.append(resource.host)
  }
}
