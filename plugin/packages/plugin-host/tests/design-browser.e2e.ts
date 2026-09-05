import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, it, vi } from 'vitest'
import { startDesignServer } from '../src/design/server.ts'

const opening = vi.hoisted(() => ({ navigate: async (_url: string) => {} }))
vi.mock('../src/desktop/index.ts', () => ({
  desktopRequest: async (_path: string, options: { body: string }) => {
    const request = JSON.parse(options.body)
    if (request.navigate) await opening.navigate(request.url)
    return {}
  }
}))

// Run only with an explicitly staged development UI and an installed Windows Edge.
it.skipIf(process.env.STARWEAVE_DESIGN_BROWSER_TEST !== '1')('saves real UI edits and restores the same workspace .fig without dialogs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'starweave-design-browser-'))
  const workspace = join(root, 'project')
  await mkdir(workspace)
  vi.stubEnv('STARWEAVE_DESIGN_STATE_DIR', '')
  vi.stubEnv('DSH_HOME', join(root, 'harness-home'))
  const profile = join(root, 'browser')
  const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' })
  const server = await startDesignServer('browser-test')
  let socket: WebSocket | undefined
  let client: Client | undefined
  try {
    let port = ''
    await vi.waitFor(async () => { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]! }, { timeout: 20_000 })
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
    socket = new WebSocket(pages.find(page => page.type === 'page')!.webSocketDebuggerUrl)
    await once(socket, 'open')
    let nextId = 0
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
    socket.on('message', data => {
      const message = JSON.parse(String(data))
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    })
    const cdp = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket!.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression: string) => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    opening.navigate = async url => { await cdp('Page.navigate', { url }) }
    const owner = server.registerOwner({ id: 'browser-chat', workspace: () => workspace })
    const connect = async () => {
      const connected = new Client({ name: 'browser-test', version: '1' })
      await connected.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer browser-test', 'x-starweave-owner': owner.token } }
      }))
      return connected
    }
    client = await connect()
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    }
    const first = await call('open_design_workspace')
    const file = join(workspace, 'designs', `Untitled-${first.id}.fig`)
    const initial = await readFile(file)
    expect(initial.length).toBeGreaterThan(100)
    expect(await evaluate('document.querySelectorAll("[data-test-id=tabbar-tab]").length')).toBe(1)
    await evaluate(`(() => { const store = window.openPencil.getStore(); store.createShape('RECTANGLE', 40, 50, 120, 80); return true })()`)
    await vi.waitFor(async () => { expect((await readFile(file)).equals(initial)).toBe(false) }, { timeout: 15_000, interval: 250 })
    await call('save_file')
    await call('save_file', { path: '../must-not-escape.fig' })
    expect(await evaluate('window.openPencil.getStore().getWorkspaceBinding().documentId')).toBe(first.id)
    await cdp('Page.navigate', { url: 'about:blank' })
    await client.close()
    client = await connect()
    const restored = await call('open_design_workspace')
    expect(restored.id).toBe(first.id)
    expect(await evaluate('window.openPencil.getStore().graph.getChildren(window.openPencil.getStore().state.currentPageId).length')).toBe(1)
    expect(await evaluate('document.querySelectorAll("[data-test-id=tabbar-tab]").length')).toBe(1)
    await call('new_document')
    expect(await evaluate('document.querySelectorAll("[data-test-id=tabbar-tab]").length')).toBe(2)
    await evaluate('document.querySelector("[data-test-id=tabbar-new]").click()')
    await evaluate('document.querySelector("[data-test-id=home-new-document]").click()')
    await vi.waitFor(async () => {
      const binding = await evaluate('JSON.parse(JSON.stringify(window.openPencil.getStore().getWorkspaceBinding()))')
      expect(binding?.documentId, JSON.stringify({ binding, text: await evaluate('document.body.innerText.slice(0,1200)') })).toBeTruthy()
      expect((await readFile(join(workspace, binding.path))).length).toBeGreaterThan(100)
    }, { timeout: 10_000 })
    expect(await evaluate('document.querySelectorAll("[data-test-id=tabbar-tab]").length')).toBe(3)
    await cdp('Browser.close')
  } finally {
    socket?.close()
    await client?.close()
    await server.close()
    browser.kill()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}, 90_000)
