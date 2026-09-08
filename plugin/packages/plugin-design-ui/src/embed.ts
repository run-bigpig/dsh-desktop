import { getCanvasKit } from '@open-pencil/core/canvaskit'
import { fontManager } from '@open-pencil/core/text'
import { createApp } from 'vue'
import { setLocale } from '@open-pencil/vue'

import App from './App.vue'
import { acquireSession, releaseSession, type DesignConnection } from './runtime.ts'
import { desktopFontsReady, loadDesktopFont, loadDesktopFonts } from './desktop-fonts.ts'
import './style.css'

export interface DesignEmbedHandle {
  unmount: () => void
  present: (signal: AbortSignal) => Promise<void>
}

export async function mount(element: HTMLElement, connection: DesignConnection): Promise<DesignEmbedHandle> {
  const baseUrl = new URL(connection.baseUrl)
  if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1') {
    throw new Error('设计画布只能连接本机服务')
  }
  fontManager.setHostFontLoader(async (family, style) =>
    await loadDesktopFont(family, style) ?? await loadBundledFont(baseUrl, family, style))
  setLocale('zh-CN')
  await getCanvasKit({ locateFile: file => new URL(file, baseUrl).href })
  await loadDesktopFonts().catch(error => console.warn('桌面中文字体初始化失败：', error))
  const session = acquireSession(connection)
  const refreshFonts = (): void => {
    void loadDesktopFonts().then(() => session.document?.editor.requestRender())
      .catch(error => console.warn('桌面中文字体初始化失败：', error))
  }
  // Navigation completion can arrive after the plugin has mounted.
  window.addEventListener(desktopFontsReady, refreshFonts)
  const app = createApp(App, { session })
  app.mount(element)
  return {
    present: signal => new Promise<void>((resolve, reject) => {
      let frame = 0
      let previous = ''
      let stable = 0
      const finish = (error?: unknown): void => {
        cancelAnimationFrame(frame)
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = (): void => finish(signal.reason)
      const timeout = setTimeout(() => finish(new Error('画布显示准备超时，请重试')), 15_000)
      const check = (): void => {
        if (session.bridgePhase === 'error' || session.bridgePhase === 'standby') { finish(); return }
        const canvas = element.querySelector<HTMLCanvasElement>('[data-starweave-rendered]')
        const bounds = canvas?.getBoundingClientRect()
        const signature = canvas && bounds && bounds.width > 0 && bounds.height > 0 && session.bridgePhase === 'connected'
          ? `${session.generation}:${bounds.width}:${bounds.height}` : ''
        stable = signature && signature === previous ? stable + 1 : 0
        previous = signature
        // Allow ResizeObserver, the renderer and the compositor to finish at
        // the attached size, including a retained editor returning offscreen.
        if (stable >= 2) { finish(); return }
        frame = requestAnimationFrame(check)
      }
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      frame = requestAnimationFrame(check)
    }),
    unmount: () => {
      window.removeEventListener(desktopFontsReady, refreshFonts)
      app.unmount()
      releaseSession(session)
    }
  }
}

const bundledFonts: Record<string, string> = {
  'Inter|Regular': 'Inter-Regular.ttf',
  'Inter|Medium': 'Inter-Medium.ttf',
  'Inter|SemiBold': 'Inter-SemiBold.ttf',
  'Inter|Bold': 'Inter-Bold.ttf',
  'Inter|ExtraBold': 'Inter-ExtraBold.ttf',
  'Noto Naskh Arabic|Regular': 'NotoNaskhArabic-Regular.ttf'
}

async function loadBundledFont(baseUrl: URL, family: string, style: string): Promise<ArrayBuffer | null> {
  const filename = bundledFonts[`${family}|${style}`]
  if (!filename) return null
  const response = await fetch(new URL(filename, baseUrl))
  return response.ok ? await response.arrayBuffer() : null
}
