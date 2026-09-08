// node canvas-connection.cjs <harness-checkout> <built-ui-dir> <playwright-module> <browser-exe> <output-dir>
// Runs production canvas HTTP/WebSocket and persistence code with isolated test files.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const [harness, ui, playwrightPath, executablePath, output] = process.argv.slice(2).map(p => path.resolve(p))
const { chromium } = require(playwrightPath)
const host = path.join(harness, 'packages/desktop/plugin-host')
const checks = []
function check(value, label) { assert.ok(value, label); checks.push(label); console.log('PASS ' + label) }
;(async () => {
  fs.mkdirSync(output, { recursive: true })
  // The production server resolves static assets relative to its source entry.
  fs.cpSync(ui, path.join(host, 'web/starweave-design'), { recursive: true })
  const { startDesignServer } = await import(pathToFileURL(path.join(host, 'src/design/server.ts')).href)
  const { createDesignDocumentStore } = await import(pathToFileURL(path.join(host, 'src/design/storage.ts')).href)
  const documents = fs.mkdtempSync(path.join(output, 'documents-'))
  const stores = new Map()
  let nextSave
  const store = id => {
    if (!stores.has(id)) {
      const disk = createDesignDocumentStore(path.join(documents, id + '.json'))
      stores.set(id, { load: disk.load, save: async document => {
        const gate = nextSave; nextSave = undefined
        if (gate) await gate()
        await disk.save(document)
      } })
    }
    return stores.get(id)
  }
  const server = await startDesignServer('isolated-test-auth', undefined, async id => store(id))
  const pageServer = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><style>body{margin:0}#root{height:100vh}</style><div id="root"></div>')
  })
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve))
  const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`
  const browser = await chromium.launch({ executablePath, headless: true })
  const connection = server.connection('connection-a')
  const errors = []
  async function pageFor(connection) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('pageerror', error => { errors.push(error.message); console.error('Editor error: ' + error.message) })
    await page.goto(pageUrl)
    await page.evaluate(async connection => {
      const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = new URL(connection.stylePath, connection.baseUrl); document.head.append(style)
      const api = await import(new URL(connection.scriptPath, connection.baseUrl).href)
      window.handle = await api.mount(document.querySelector('#root'), connection)
      await window.handle.present(AbortSignal.timeout(15000))
    }, connection)
    return page
  }
  async function rpc(command, args) {
    const response = await server.sendRPC(connection.sessionId, command, args)
    assert.equal(response.ok, true, response.error)
    return response.result
  }
  const tool = (name, args) => rpc('tool', { document_id: connection.sessionId, name, args })
  try {
    const owner = await pageFor(connection)
    await owner.locator('.bridge-state[data-phase="connected"]').waitFor()
    await server.waitForReady(connection.sessionId, AbortSignal.timeout(5000))
    check(true, 'first canvas initializes through the production server')
    check(await owner.locator('[data-starweave-rendered]').count() === 1, 'presentation waits for the document canvas first render')
    await owner.setViewportSize({ width: 520, height: 900 })
    await owner.evaluate(() => window.handle.present(AbortSignal.timeout(15000)))
    check((await owner.locator('.editor-workspace').boundingBox()).width === 520, 'retained editor settles at the narrow details width')
    await owner.setViewportSize({ width: 1400, height: 900 })
    await owner.evaluate(() => window.handle.present(AbortSignal.timeout(15000)))
    check(await owner.evaluate(async () => {
      const abort = new AbortController(); abort.abort()
      try { await window.handle.present(abort.signal); return false } catch { return true }
    }), 'cancelled presentation does not wait or reveal a stale editor')
    const shape = await tool('create_shape', { type: 'RECTANGLE', x: 0, y: 0, width: 240, height: 160, name: 'Owner rectangle' })
    await owner.locator('[data-save-state="saved"]').waitFor()
    const light = owner.locator('.bridge-state')
    check(await light.innerText() === '' && await light.getAttribute('title') === 'Agent 已连接当前文档', 'connection uses a light with hover text instead of a persistent label')
    const dot = await light.boundingBox()
    check(dot.width === 8 && dot.height === 8 && await light.getAttribute('aria-label') === 'Agent 已连接当前文档', 'connection light has compact dimensions and an accessible status')
    let finishSave
    let saveStarted
    const savingStarted = new Promise(resolve => { saveStarted = resolve })
    nextSave = () => new Promise(resolve => { finishSave = resolve; saveStarted() })
    const stateAfterEdit = await owner.evaluate(async () => {
      const workspace = document.querySelector('.editor-workspace')
      workspace.focus()
      workspace.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      workspace.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      await Promise.resolve()
      return document.querySelector('[data-save-state]').dataset.saveState
    })
    check(stateAfterEdit === 'unsaved', 'manual edits immediately change saved to unsaved before autosave starts')
    await owner.locator('[data-save-state="saving"]').waitFor()
    check(true, 'pending persistence displays saving until disk acknowledgement')
    await savingStarted
    finishSave()
    await owner.locator('[data-save-state="saved"]').waitFor()
    check(true, 'successful autosave returns the current revision to saved')
    nextSave = async () => { throw new Error('Simulated disk failure') }
    await owner.locator('.editor-workspace').press('ArrowRight')
    await owner.locator('[data-save-state="error"]').waitFor()
    check(true, 'failed autosave displays failure instead of saved')
    await rpc('flush_document', {})
    await owner.locator('[data-save-state="saved"]').waitFor()
    check(true, 'successful retry clears the failure state')
    const waiting = await pageFor(connection)
    await waiting.locator('.bridge-state[data-phase="standby"]').waitFor()
    check(await owner.locator('.bridge-state[data-phase="connected"]').count() === 1, 'second page does not evict the current canvas')
    check(await waiting.getByRole('button', { name: '保存', exact: true }).isDisabled(), 'standby canvas cannot save or edit its placeholder document')
    await tool('set_fill', { id: shape.id, color: '#0000FF' })
    const before = await tool('export_image', { ids: [shape.id] })
    check(before.byteLength > 100, 'Agent commands still reach the original editor while another page waits')
    const independent = await pageFor(server.connection('connection-b'))
    await independent.locator('.bridge-state[data-phase="connected"]').waitFor()
    check(true, 'a different session connects independently')
    await owner.close()
    await waiting.locator('.bridge-state[data-phase="connected"]').waitFor({ timeout: 15000 })
    await server.waitForReady(connection.sessionId, AbortSignal.timeout(5000))
    check(true, 'waiting page reconnects automatically after the owner exits')
    const tree = await tool('get_page_tree', {})
    const find = value => value && typeof value === 'object' ? (value.name === 'Owner rectangle' ? value : Object.values(value).map(find).find(Boolean)) : undefined
    const restored = find(tree)
    check(restored, 'reconnected editor restores the most recent saved document')
    const after = await tool('export_image', { ids: [restored.id] })
    check(after.base64 === before.base64, 'restored design renders identically after connection transfer')
    await tool('create_shape', { type: 'ELLIPSE', x: 300, y: 0, width: 80, height: 80, name: 'After reconnect' })
    await rpc('flush_document', {})
    check(Boolean((await store(connection.sessionId).load())?.data), 'Agent editing and persistence continue after reconnect')
    await waiting.close()
    const reopened = await pageFor(connection)
    await reopened.locator('.bridge-state[data-phase="connected"]').waitFor()
    const latest = await tool('get_page_tree', {})
    check(JSON.stringify(latest).includes('After reconnect'), 'a later reopening retains edits made after recovery')
    check(errors.length === 0, 'no uncaught editor errors')
    await reopened.screenshot({ path: path.join(output, 'reconnected.png') })
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2))
  } finally { await browser.close(); await server.close(); await new Promise(resolve => pageServer.close(resolve)) }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
