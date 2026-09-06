import { getCanvasKit } from '@open-pencil/core/canvaskit'
import { createApp } from 'vue'

import App from './App.vue'
import { acquireSession, releaseSession, type DesignConnection } from './runtime.ts'
import './style.css'

export interface DesignEmbedHandle { unmount: () => void }

async function mount(element: HTMLElement, connection: DesignConnection): Promise<DesignEmbedHandle> {
  const baseUrl = new URL(connection.baseUrl)
  if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1') {
    throw new Error('设计画布只能连接本机服务')
  }
  await getCanvasKit({ locateFile: file => new URL(file, baseUrl).href })
  const session = acquireSession(connection)
  const app = createApp(App, { session })
  app.mount(element)
  return {
    unmount: () => {
      app.unmount()
      releaseSession(session)
    }
  }
}

window.StarWeaveDesignEmbed = { mount }

declare global {
  interface Window {
    StarWeaveDesignEmbed?: { mount: typeof mount }
  }
}
