import { getCanvasKit } from '@open-pencil/core/canvaskit'
import { fontManager } from '@open-pencil/core/text'
import { createApp } from 'vue'
import { setLocale } from '@open-pencil/vue'

import App from './App.vue'
import { acquireSession, releaseSession, type DesignConnection } from './runtime.ts'
import { desktopFontsReady, loadDesktopFont, loadDesktopFonts } from './desktop-fonts.ts'
import './style.css'

export interface DesignEmbedHandle { unmount: () => void }

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
