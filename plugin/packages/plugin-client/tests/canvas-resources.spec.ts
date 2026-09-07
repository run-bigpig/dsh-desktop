// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { CanvasResources } from '../src/client/design/canvas-resources.ts'

it('retains an offscreen canvas and renderer across details unmounts without sharing documents', async () => {
  const unmount = vi.fn()
  const mount = vi.fn(async () => ({ unmount }))
  const resources = new CanvasResources(async () => ({ mount }))
  const connection = { baseUrl: 'http://127.0.0.1:7000/', sessionId: 'a', token: 'test', stylePath: 'style.css', scriptPath: 'embed.js' }
  const first = document.createElement('div')
  const second = document.createElement('div')
  document.body.append(first, second)
  try {
    const attached = resources.attach(connection, first)
    await attached.ready
    const host = first.firstElementChild as HTMLElement
    attached.detach()
    expect(host.parentElement).toBe(document.body)
    expect(host.style.width).toBe('1000px')
    expect(host.inert).toBe(true)
    expect(unmount).not.toHaveBeenCalled()
    await resources.ensure({ ...connection, sessionId: 'b' }).ready
    const remounted = resources.attach(connection, second)
    await remounted.ready
    expect(second.firstElementChild).toBe(host)
    expect(host.inert).toBe(false)
    expect(mount).toHaveBeenCalledTimes(2)
    resources.remove('a')
    expect(unmount).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-starweave-canvas-session="b"]')).not.toBeNull()
  } finally { resources.dispose();first.remove();second.remove() }
  expect(unmount).toHaveBeenCalledTimes(2)
})
