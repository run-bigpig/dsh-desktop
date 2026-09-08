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
      socket.send(JSON.stringify({ type: 'registered', sessionId, persistence: true, document: snapshots.get(sessionId) }))
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
const tool = (name, args) => rpc('a', 'tool', { document_id: 'a', name, args })
;(async () => {
  fs.mkdirSync(output, { recursive: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const browser = cdpUrl ? await chromium.connectOverCDP(cdpUrl) : await chromium.launch({ executablePath, headless: true })
  const page = cdpUrl
    ? browser.contexts()[0].pages().find(page => page.url().startsWith('http://127.0.0.1:'))
    : await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  assert.ok(page, 'Wails Harness page must be running')
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()) })
  try {
    async function mount(sessionId, reload = false) {
      if (cdpUrl) {
        if (reload) await page.reload()
        await page.waitForFunction(() => Boolean(window.__STARWEAVE_DESIGN_FONTS__))
        // Exercise the real Wails page/injected capability, but mount the
        // editor in a disposable shadow root with isolated test persistence.
        await page.evaluate(async url => {
          document.querySelector('#font-smoke')?.remove()
          const host = document.createElement('div'); host.id = 'font-smoke'
          host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#202020'
          const shadow = host.attachShadow({ mode: 'open' })
          shadow.innerHTML = `<link rel="stylesheet" href="${url}starweave-design-embed.css"><div id="root" style="height:100vh"></div>`
          document.body.append(host)
          window.embed = await import(url + 'starweave-design-embed.js')
        }, url)
      } else {
        if (reload) await page.goto('about:blank')
        await page.goto(url)
      }
      await page.waitForFunction(() => Boolean(window.embed))
      await page.evaluate(async ({ url, sessionId }) => { window.handle = await window.embed.mount(document.querySelector('#font-smoke')?.shadowRoot.querySelector('#root') ?? document.querySelector('#root'), { baseUrl: url, sessionId, token: 'isolated-test' }) }, { url, sessionId })
      await page.locator('.bridge-state[data-phase="connected"]').waitFor()
      await page.locator('canvas[data-ready="1"]').waitFor()
    }
    await mount('a')
    const rectangle = await tool('create_shape', { type: 'RECTANGLE', x: 0, y: 0, width: 200, height: 100, name: 'Image rectangle' })
    await tool('set_fill', { id: rectangle.id, color: '#0000ff' })
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 16, 16); ctx.fillStyle = '#00ff00'; ctx.fillRect(16, 0, 16, 16)
      return canvas.toDataURL().split(',')[1]
    })
    await page.getByLabel('颜色类型', { exact: true }).selectOption('IMAGE')
    await page.getByLabel('填充图片文件', { exact: true }).setInputFiles({ name: 'pattern.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    await page.getByAltText('填充图片预览').waitFor()
    await page.getByLabel('图片缩放模式').focus()
    await page.getByLabel('图片缩放模式').press('Tab')
    await page.getByLabel('图片缩放模式').focus()
    await page.getByLabel('图片缩放模式').selectOption('FIT')
    await page.getByLabel('图片缩放模式').press('Tab')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    assert.equal(await page.getByLabel('图片缩放模式').inputValue(), 'FILL')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    assert.equal(await page.getByLabel('图片缩放模式').inputValue(), 'FIT')
    const originalImage = await tool('export_image', { ids: [rectangle.id] })
    fs.writeFileSync(path.join(output, 'image-fill.png'), Buffer.from(originalImage.base64, 'base64'))
    const style = await rpc('a', 'shared_style', { action: 'create', kind: 'fill', node_id: rectangle.id, name: 'Images/Hero' })
    assert.equal(await page.getByLabel('fill 样式', { exact: true }).inputValue(), style.style_id)
    await page.locator('[data-style-kind="fill"] summary').click()
    page.once('dialog', dialog => dialog.accept('Images/Renamed'))
    await page.locator('[data-style-kind="fill"]').getByRole('button', { name: '重命名样式' }).click()
    const listed = await rpc('a', 'shared_style', { action: 'list', kind: 'fill' })
    assert.equal(listed.styles[0].name, 'Images/Renamed')
    const second = await tool('create_shape', { type: 'RECTANGLE', x: 300, y: 0, width: 200, height: 100, name: 'Bound rectangle' })
    await rpc('a', 'shared_style', { action: 'apply', kind: 'fill', style_id: style.style_id, node_ids: [second.id] })
    assert.equal(await page.getByLabel('图片缩放模式').inputValue(), 'FIT')
    const vector = await tool('create_vector', { x: 0, y: 200, name: 'Editable path', path: 'M0 0 L100 0 L50 80 Z', fill: '#ff0000' })
    await tool('viewport_set', { x: 50, y: 240, zoom: 2 })
    await page.getByRole('button', { name: '编辑路径', exact: true }).click()
    const bounds = await page.locator('canvas.design-canvas').boundingBox()
    const anchor = { x: bounds.x + bounds.width / 2 - 100, y: bounds.y + bounds.height / 2 - 80 }
    await page.mouse.move(anchor.x, anchor.y); await page.mouse.down()
    await page.mouse.move(anchor.x - 40, anchor.y, { steps: 8 }); await page.mouse.up()
    await page.getByRole('button', { name: '撤销路径编辑' }).click()
    await page.getByRole('button', { name: '重做路径编辑' }).click()
    await page.screenshot({ path: path.join(output, 'vector-edit.png') })
    await page.getByRole('button', { name: '完成路径', exact: true }).click()
    const moved = await tool('get_node', { id: vector.id })
    assert.equal(moved.x, -20)
    assert.equal(moved.width, 120)
    await tool('select_nodes', { ids: [rectangle.id] })
    // Switch and rebuild the browser module, forcing .fig decoding from stored bytes.
    await page.waitForTimeout(500)
    assert.ok(snapshots.get('a')?.data.length)
    await mount('b', true)
    assert.equal(await page.locator('.layer-row').count(), 0)
    await mount('a', true)
    assert.equal(await page.locator('.layer-row').count(), 3)
    const restoredStyles = await rpc('a', 'shared_style', { action: 'list', kind: 'fill' })
    assert.equal(restoredStyles.styles[0].name, 'Images/Renamed')
    const imageNode = await tool('find_nodes', { name: 'Image rectangle' })
    const restoredImage = await tool('export_image', { ids: [imageNode.nodes[0].id] })
    assert.equal(restoredImage.base64, originalImage.base64)
    await tool('select_nodes', { ids: [imageNode.nodes[0].id] })
    await page.getByAltText('填充图片预览').waitFor()
    await page.screenshot({ path: path.join(output, 'restored-image-style.png') })
    if (cdpUrl) {
      const text = await tool('create_shape', { type: 'TEXT', x: 0, y: 400, width: 700, height: 100, name: '中文字体验收' })
      await tool('set_font', { id: text.id, family: 'Inter', size: 48 })
      await tool('set_text', { id: text.id, text: '中文画布，自动设计！ABC 123' })
      await tool('set_fill', { id: text.id, color: '#ffffff' })
      await tool('viewport_set', { x: 350, y: 440, zoom: 1 })
      const before = await tool('export_image', { ids: [text.id] })
      await tool('set_text', { id: text.id, text: '方框画布，自动设计！ABC 123' })
      const differentGlyphs = await tool('export_image', { ids: [text.id] })
      assert.notEqual(differentGlyphs.base64, before.base64, 'Distinct Chinese characters rendered as identical missing-glyph boxes')
      await tool('set_text', { id: text.id, text: '中文画布，自动设计！ABC 123' })
      fs.writeFileSync(path.join(output, 'chinese-text.png'), Buffer.from(before.base64, 'base64'))
      await page.screenshot({ path: path.join(output, 'wails-chinese-canvas.png') })
      // A fresh WebView document must receive Wails injection again, before
      // restoring the stored .fig with its original Inter font declaration.
      await mount('b', true)
      assert.equal(await page.locator('.layer-row').count(), 0)
      await mount('a', true)
      const restoredText = await tool('find_nodes', { name: '中文字体验收' })
      const after = await tool('export_image', { ids: [restoredText.nodes[0].id] })
      fs.writeFileSync(path.join(output, 'chinese-text-restored.png'), Buffer.from(after.base64, 'base64'))
      const pixels = await page.evaluate(async ({ before, after }) => {
        const decode = async base64 => {
          const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode()
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
          return context.getImageData(0, 0, image.width, image.height)
        }
        const a = await decode(before); const b = await decode(after)
        if (a.width !== b.width || a.height !== b.height) throw new Error('Restored text dimensions changed')
        let visible = 0
        for (let i = 3; i < a.data.length; i += 4) if (a.data[i] > 0) visible++
        // The official .fig import rounds this text baseline by one pixel.
        // Require identical glyph coverage, allowing only that vertical shift.
        const differences = [-1, 0, 1].map(dy => {
          let changed = 0
          for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
            const original = a.data[(y * a.width + x) * 4 + 3]
            const restored = y + dy < 0 || y + dy >= b.height ? 0 : b.data[((y + dy) * b.width + x) * 4 + 3]
            if (original !== restored) changed++
          }
          return changed
        })
        return { differences, visible }
      }, { before: before.base64, after: after.base64 })
      assert.ok(pixels.visible > 1000 && pixels.differences.includes(0), JSON.stringify(pixels))
      assert.equal(await page.evaluate(() => window.__STARWEAVE_DESIGN_FONTS__.family), 'SimHei')
    }
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ imageFill: true, imageUndoRedo: true, sharedStyles: true, vectorDragUndoRedo: true, sessionIsolation: true, figRestoration: true, identicalImageExport: true, wailsChineseFont: Boolean(cdpUrl), errors }))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    console.error(error)
    process.exitCode = 1
  } finally {
    if (cdpUrl) await page.reload().catch(() => {})
    await browser.close(); for (const socket of wss.clients) socket.terminate(); wss.close(); server.close()
  }
})().catch(error => {
  console.error(error); process.exitCode = 1
  for (const socket of wss.clients) socket.terminate()
  wss.close(); server.close()
})
