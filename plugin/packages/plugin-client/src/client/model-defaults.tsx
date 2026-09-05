import { useEffect, useRef } from 'react'
import type { ModelDirectory, ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

export interface ModelDefaultsInjected {
  readonly available: boolean
  readonly directory: ModelDirectory
  readonly hooks: { readonly models: ModelDirectory['store'] }
}

export function defaultModelFallback(state: ModelDirectoryState) {
  if (state.status !== 'ready' || state.current === null) return undefined
  if (state.current.provider !== 'deepseek-official' && state.current.provider !== 'dsh-unconfigured') return undefined
  if (state.routable !== false) return undefined
  for (const group of state.groups) {
    if (group.id === 'deepseek-official' || group.id === 'dsh-unconfigured') continue
    const model = group.models[0]
    if (model !== undefined) return {
      provider: group.id,
      model: model.id,
      ...(model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort }),
    }
  }
  return undefined
}

/** Correct retired desktop defaults through the shared Harness selection service. */
export function ModelDefaults({ available, directory, useModels }: InjectFace<ModelDefaultsInjected>) {
  const state = useModels(snapshot => snapshot)
  const attempted = useRef<string>()
  useEffect(() => {
    if (!available) return
    const selection = defaultModelFallback(directory.store.getSnapshot())
    if (selection === undefined) return
    const key = JSON.stringify(selection)
    if (attempted.current === key) return
    attempted.current = key
    // The directory owns selection errors and exposes them in the native picker.
    void directory.select(selection).catch(() => {})
  }, [available, directory, state])
  return null
}
