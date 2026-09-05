// @vitest-environment jsdom

import { useSyncExternalStore } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelDirectory, ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ModelDefaults, defaultModelFallback } from '../src/client/model-defaults.tsx'

afterEach(cleanup)

function snapshot(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    status: 'ready', error: null, current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: false, failures: [],
    groups: [{ id: 'custom', name: 'Custom', models: [{ id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }] }],
    ...overrides,
  }
}

describe('desktop model defaults', () => {
  it('replaces the retired or unconfigured route with an advertised model and its effort', () => {
    for (const provider of ['deepseek-official', 'dsh-unconfigured']) {
      expect(defaultModelFallback(snapshot({ current: { provider, model: 'old' } })))
        .toEqual({ provider: 'custom', model: 'model-a', reasoningEffort: 'high' })
    }
  })

  it('preserves user choices, live routes and unresolved or unavailable catalogs', () => {
    for (const state of [
      snapshot({ current: { provider: 'custom', model: 'unadvertised-model' } }),
      snapshot({ routable: true }), snapshot({ status: 'loading' }), snapshot({ status: 'error' }),
      snapshot({ groups: [] }), snapshot({ current: null }),
    ]) expect(defaultModelFallback(state)).toBeUndefined()
  })

  it('selects when models arrive without looping while the durable projection catches up', async () => {
    let state = snapshot({ status: 'loading', groups: [] })
    const listeners = new Set<() => void>()
    const store = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const select = vi.fn(async () => {})
    const directory = { store, select } as unknown as ModelDirectory
    const useModels = <T,>(selector: (value: ModelDirectoryState) => T) => selector(useSyncExternalStore(store.subscribe, store.getSnapshot))
    render(<ModelDefaults available directory={directory} useModels={useModels} />)
    expect(select).not.toHaveBeenCalled()
    act(() => { state = snapshot(); listeners.forEach(listener => listener()) })
    await waitFor(() => { expect(select).toHaveBeenCalledWith({ provider: 'custom', model: 'model-a', reasoningEffort: 'high' }) })
    act(() => { state = snapshot(); listeners.forEach(listener => listener()) })
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('does not select a model for addressed subagents', () => {
    const state = snapshot()
    const select = vi.fn()
    const directory = { store: { getSnapshot: () => state }, select } as unknown as ModelDirectory
    render(<ModelDefaults available={false} directory={directory} useModels={selector => selector(state)} />)
    expect(select).not.toHaveBeenCalled()
  })
})
