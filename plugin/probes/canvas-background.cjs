// Usage: node browser-smoke.cjs <bundle-dir> <playwright-module> <ws-module> <browser-exe> <output-dir> [Wails-CDP-URL]
// Uses isolated in-memory session storage, never a user's running Harness profile.
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const [rootArg, playwrightPath, wsPath, executablePath, outputArg, cdpUrl] = process.argv.slice(2)
const root = path.resolve(rootArg)
const output = path.resolve(outputArg)
const { chromium } = require(playwrightPath)
const { WebSocketServer } = require(wsPath)
const snapshots = new Map()
const bindings = new Map([['a', { id: 'first-a', path: 'first.fig', hash: null }], ['b', { id: 'first-b', path: 'other.fig', hash: null }]])
const sockets = new Map()
const pending = new Map()
const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><style>body{margin:0}#root{height:100vh}</style><link rel="stylesheet" href="/starweave-design-embed.css"><div id="root"></div><script type="module">import * as embed from "/starweave-design-embed.js"; window.embed=embed;</script>')
    return
  }
  const file = path.resolve(root, pathname.slice(1))
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return }
  response.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream')
  fs.createReadStream(file).pipe(response)
})
const wss = new WebSocketServer({ server, path: '/bridge' })
wss.on('connection', socket => {
  let sessionId
  socket.on('message', raw => {
    const message = JSON.parse(raw)
    if (message.type === 'register') {
      sessionId = message.sessionId
      sockets.set(sessionId, socket)
      socket.send(JSON.stringify({ type: 'registered', sessionId, persistence: true, binding: bindings.get(sessionId), document: snapshots.get(sessionId) }))
    } else if (message.type === 'persist_document') {
      snapshots.set(sessionId, message.document)
      socket.send(JSON.stringify({ type: 'persisted', id: message.id }))
    } else if (message.type === 'response') {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (waiter) { clearTimeout(waiter.timer); message.ok ? waiter.resolve(message.result) : waiter.reject(new Error(message.error)) }
    }
  })
})
function rpc(sessionId, command, args) {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timed out: ' + command)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    sockets.get(sessionId).send(JSON.stringify({ type: 'request', id, command, args }))
  })
}
const tool = (sessionId, name, args) => rpc(sessionId, 'tool', { document_id: `${sessionId}:${bindings.get(sessionId).id}`, name, args })

;(async () => {
  fs.mkdirSync(output, { recursive: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean(window.embed))
    await page.evaluate(async url => {
      const root = document.querySelector('#root')
      root.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:800px'
      root.inert = true
      window.a = await window.embed.mount(root, { baseUrl: url, sessionId: 'a', token: 'test-a' })
      const second = document.createElement('div'); second.id = 'second';second.style.height = '100vh';document.body.append(second)
      window.b = await window.embed.mount(second, { baseUrl: url, sessionId: 'b', token: 'test-b' })
    }, url)
    await page.waitForFunction(() => document.querySelectorAll('.bridge-state[data-phase="connected"]').length === 2)
    const first = await tool('a', 'create_shape', { type: 'RECTANGLE', x: 0, y: 0, width: 240, height: 160, name: 'Background A' })
    await tool('a', 'set_fill', { id: first.id, color: '#ff0000' })
    const image = await tool('a', 'export_image', { ids: [first.id] })
    assert.ok(image.base64 && image.byteLength > 100, JSON.stringify(image))
    fs.writeFileSync(path.join(output, 'hidden-a.png'), Buffer.from(image.base64, 'base64'))
    const second = await tool('b', 'create_shape', { type: 'ELLIPSE', x: 0, y: 0, width: 120, height: 120, name: 'Visible B' })
    assert.ok(second.id)
    assert.equal(await page.locator('#second .layer-row').count(), 1)
    assert.equal(await page.locator('#root .layer-row').count(), 1)
    assert.ok((await page.locator('#second .layer-row').allTextContents()).join('').includes('Visible B'))
    assert.ok(!(await page.locator('#second .layer-row').allTextContents()).join('').includes('Background A'))
    await page.evaluate(() => {
      const root = document.querySelector('#root')
      root.style.cssText = 'width:1000px;height:800px';root.inert = false
      document.querySelector('#second').style.display = 'none'
      document.body.append(root)
    })
    const returned = await tool('a', 'export_image', { ids: [first.id] })
    assert.equal(returned.base64, image.base64, 'hidden/visible transition changes the same document')
    assert.ok(snapshots.has('a') && snapshots.has('b'), 'both session documents persisted independently')
    const savedFirst = snapshots.get('a')
    assert.equal(savedFirst.binding.path, 'first.fig')
    fs.writeFileSync(path.join(output, 'first.fig'), Buffer.from(savedFirst.data, 'base64'))
    bindings.set('a', { id: 'second-a', path: 'second.fig', hash: null })
    await rpc('a', 'switch_document', { binding: bindings.get('a') })
    await tool('a', 'create_shape', { type: 'RECTANGLE', x: 0, y: 0, width: 60, height: 60, name: 'Second file A' })
    await rpc('a', 'flush_document', {})
    assert.equal(snapshots.get('a').binding.path, 'second.fig')
    await assert.rejects(rpc('a', 'tool', { document_id: 'a:first-a', name: 'create_shape', args: { type: 'RECTANGLE', width: 20, height: 20 } }), /文档已切换/)
    bindings.set('a', { id: 'reopened-a', path: 'first.fig', hash: null })
    await rpc('a', 'switch_document', { document: savedFirst, binding: bindings.get('a') })
    await rpc('a', 'flush_document', {})
    assert.ok((await page.locator('#root .layer-row').allTextContents()).join('').includes('Background A'))
    assert.ok(!(await page.locator('#root .layer-row').allTextContents()).join('').includes('Second file A'))
    const tree = await tool('a', 'get_page_tree', {})
    const find = value => value && typeof value === 'object' ? (value.name === 'Background A' ? value : Object.values(value).map(find).find(Boolean)) : undefined
    const restoredNode = find(tree)
    assert.ok(restoredNode, JSON.stringify(tree))
    const reopened = await tool('a', 'export_image', { ids: [restoredNode.id] })
    assert.equal(reopened.base64, image.base64, 'reopening the file must restore the actual saved design')
    await page.screenshot({ path: path.join(output, 'restored-canvas.png') })
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ hiddenEdit: true, hiddenExport: true, isolatedDocuments: true, identicalExportAfterReturn: true, independentPersistence: true, fileSwitchAndReopen: true, staleDocumentRejected: true }))
    console.log('PASS hidden canvas edit/export, independent sessions, return without document reset, independent persistence')
  } finally {
    await page.evaluate(() => { window.a?.unmount();window.b?.unmount() }).catch(() => {})
    await browser.close();for (const socket of wss.clients) socket.terminate();wss.close();server.close()
  }
})().catch(error => { console.error(error);process.exitCode = 1;for (const socket of wss.clients) socket.terminate();wss.close();server.close() })
