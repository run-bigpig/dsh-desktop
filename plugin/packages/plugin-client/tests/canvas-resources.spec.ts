// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { CanvasResources } from '../src/client/design/canvas-resources.ts'

function styleLoaded() {
  for (const host of document.querySelectorAll('[data-starweave-canvas-session]')) {
    host.shadowRoot!.querySelector('link')!.dispatchEvent(new Event('load'))
  }
}

it('retains an offscreen canvas and renderer across details unmounts without sharing documents', async () => {
  const unmount = vi.fn()
  const present = vi.fn(async () => {})
  const mount = vi.fn(async () => ({ unmount, present }))
  const resources = new CanvasResources(async () => ({ mount }))
  const connection = { baseUrl: 'http://127.0.0.1:7000/', sessionId: 'a', token: 'test', stylePath: 'style.css', scriptPath: 'embed.js' }
  const first = document.createElement('div')
  const second = document.createElement('div')
  document.body.append(first, second)
  try {
    const attached = resources.attach(connection, first)
    styleLoaded()
    await attached.ready
    const host = first.firstElementChild as HTMLElement
    attached.detach()
    expect(host.parentElement).toBe(document.body)
    expect(host.style.width).toBe('1000px')
    expect(host.inert).toBe(true)
    expect(unmount).not.toHaveBeenCalled()
    const other = resources.ensure({ ...connection, sessionId: 'b' })
    styleLoaded()
    await other.ready
    const remounted = resources.attach(connection, second)
    await remounted.ready
    expect(second.firstElementChild).toBe(host)
    expect(host.inert).toBe(false)
    expect(mount).toHaveBeenCalledTimes(2)
    expect(present).toHaveBeenCalledTimes(2)
    resources.remove('a')
    expect(unmount).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-starweave-canvas-session="b"]')).not.toBeNull()
  } finally { resources.dispose();first.remove();second.remove() }
  expect(unmount).toHaveBeenCalledTimes(2)
})

it('waits for styles before mounting and cancels presentation after detaching', async () => {
  const present = vi.fn(async () => {})
  const mount = vi.fn(async () => ({ unmount: vi.fn(), present }))
  const resources = new CanvasResources(async () => ({ mount }))
  const target = document.createElement('div')
  document.body.append(target)
  const connection = { baseUrl: 'http://127.0.0.1:7000/', sessionId: 'slow', token: 'test', stylePath: 'style.css', scriptPath: 'embed.js' }
  try {
    const attached = resources.attach(connection, target)
    const cancelled = expect(attached.ready).rejects.toThrow()
    await Promise.resolve()
    expect(mount).not.toHaveBeenCalled()
    attached.detach()
    styleLoaded()
    await cancelled
    expect(present).not.toHaveBeenCalled()
    const reopened = resources.attach(connection, target)
    await reopened.ready
    expect(mount).toHaveBeenCalledOnce()
    expect(present).toHaveBeenCalledOnce()
  } finally { resources.dispose(); target.remove() }
})
