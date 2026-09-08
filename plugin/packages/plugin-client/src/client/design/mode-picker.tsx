import './mode-picker.module.css'
import { useCallback, useEffect, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentPresetLabelInjected, AgentPresetLabelProps, AgentPresetSeatInjected, AgentPresetSeatProps,
} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export function visibleModes<T extends { id: string }>(options: readonly T[]): T[] {
  return options.filter(option => option.id !== 'design')
}

export function ModePicker({ component: Component, ...props }: AgentPresetSeatProps & { component: ComponentType<AgentPresetSeatProps> }) {
  const current = props.useAgentPresetSeat(state => state.current)
  useEffect(() => { if (current === 'design') void props.select('standard') }, [current, props.select])
  const useModes: AgentPresetSeatProps['useAgentPresetSeat'] = useCallback((selector, equal) =>
    props.useAgentPresetSeat(state => selector({ ...state, options: visibleModes(state.options) }), equal),
  [props.useAgentPresetSeat])
  return <Component {...props} useAgentPresetSeat={useModes} />
}

export function SessionPresetLabel({ component: Component, ...props }: AgentPresetLabelProps & { component: ComponentType<AgentPresetLabelProps> }) {
  const preset = props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset)
  // Historical design sessions retain their composition and canvas recovery.
  return preset === 'design' ? null : <Component {...props} />
}

/** The official settings nav lists raw registrations, so do not shadow its section. */
export function hideLegacyPresetCards(root: HTMLElement): () => void {
  const hidden = new Set<HTMLElement>()
  const sync = (): void => {
    for (const card of hidden) {
      if (!root.contains(card)) { card.removeAttribute('data-starweave-retired-preset'); hidden.delete(card) }
    }
    for (const code of root.querySelectorAll('[data-slot="settings.section"] li > button[aria-pressed] > code')) {
      const card = code.parentElement!.parentElement!
      if (code.textContent === 'design') {
        card.setAttribute('data-starweave-retired-preset', '')
        hidden.add(card)
      } else if (hidden.delete(card)) card.removeAttribute('data-starweave-retired-preset')
    }
  }
  const observer = new MutationObserver(sync)
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  sync()
  return () => {
    observer.disconnect()
    for (const card of hidden) card.removeAttribute('data-starweave-retired-preset')
  }
}

function RetiredPresetCards() {
  useEffect(() => hideLegacyPresetCards(document.body), [])
  return null
}

// Shadow only the presentation seats through the official registry. Keep the
// original controllers, selection lifecycle and backend roster for old sessions.
export function applyModePicker(ctx: Context): void {
  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action', id: 'desktop-retired-design-preset',
  }, RetiredPresetCards))
  ctx.effect(() => {
    let seat: StoredEntry | undefined
    let stopSeat: (() => void) | undefined
    const syncSeat = (): void => {
      const source = ctx.slots.entries('conversation.hero.agentPreset').find(entry => (entry.options.priority ?? 0) >= 0)
      if (source === seat) return
      stopSeat?.()
      seat = source
      if (!source) return
      const Component = source.component as ComponentType<AgentPresetSeatProps>
      stopSeat = ctx.slots.register({
        name: 'conversation.hero.agentPreset', priority: -100, locale: 'settings.agentPreset',
        inject: () => source.inject!() as unknown as AgentPresetSeatInjected,
      }, (props: AgentPresetSeatProps) => <ModePicker {...props} component={Component} />)
    }
    const seatSubscription = ctx.slots.subscribe('conversation.hero.agentPreset', syncSeat)
    syncSeat()
    let label: StoredEntry | undefined
    let stopLabel: (() => void) | undefined
    const syncLabel = (): void => {
      const source = ctx.slots.entries('conversation.session.header.actions').find(entry => entry.options.id === 'agent-preset' && (entry.options.priority ?? 0) >= 0)
      if (source === label) return
      stopLabel?.()
      label = source
      if (!source) return
      const Component = source.component as ComponentType<AgentPresetLabelProps>
      stopLabel = ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'agent-preset', order: -10,
        priority: -100, locale: 'settings.agentPreset',
        inject: () => source.inject!() as unknown as AgentPresetLabelInjected,
      }, (props: AgentPresetLabelProps) => <SessionPresetLabel {...props} component={Component} />)
    }
    const labelSubscription = ctx.slots.subscribe('conversation.session.header.actions', syncLabel)
    syncLabel()
    return () => {
      seatSubscription()
      stopSeat?.()
      labelSubscription()
      stopLabel?.()
    }
  }, 'starweave: retire design preset presentation')
}
