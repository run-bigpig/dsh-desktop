// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactResultTail, canvasResultDefinition, selectArtifactResultTail } from '../src/client/design/CanvasResultTail.tsx'

afterEach(cleanup)
const artifact = { kind: 'starweave-canvas', path: 'designs/landing.fig', name: 'landing.fig', hash: 'saved-hash', saved: true }
function event(type: string, seq: number, data: unknown) { return { event: { type, seq, data } } as never }

it('promotes only successful saves from the owning tool into durable conversation data', () => {
  let state = canvasResultDefinition.start({} as never, event('turn/start', 1, { turn: 2 }), {} as never)
  state = canvasResultDefinition.update({ state } as never, event('tool/call', 2, { turn: 2, callId: 'save', name: 'save_canvas' }))
  const result = (isError: boolean) => ({ turn: 2, message: { source: { callId: 'save' }, content: [{ type: 'tool-result', isError, content: [{ type: 'text', text: JSON.stringify(artifact) }] }] } })
  state = canvasResultDefinition.update({ state } as never, event('tool/result', 3, result(true)))
  expect(state.files).toHaveLength(0)
  state = canvasResultDefinition.update({ state } as never, event('tool/result', 4, result(false)))
  expect(canvasResultDefinition.buildLocationData?.({ state } as never, 'turn')).toMatchObject({
    key: 'desktop-canvas-results', value: { files: [{ seq: 4, artifact }] },
  })
  const owner = (seq: number) => ({ seq, turn: { data: { get: (key: string) => key === 'desktop-canvas-results' ? state : undefined } } }) as never
  expect(selectArtifactResultTail(owner(3))).toBeNull()
  expect(selectArtifactResultTail(owner(4))).toMatchObject({ canvases: [artifact] })
})

it('reopens the actual saved path in its source session and displays an opening failure', async () => {
  const openCanvasFile = vi.fn().mockRejectedValue(new Error('File is missing'))
  const view = render(<ArtifactResultTail {...{ sessionId: 'session-a', matched: { images: [], canvases: [artifact] }, openCanvasFile } as never} />)
  fireEvent.click(view.getByRole('button', { name: /landing.fig/ }))
  await waitFor(() => expect(openCanvasFile).toHaveBeenCalledWith('session-a', 'designs/landing.fig', undefined))
  expect(await view.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('File is missing'))
})
