import { useCallback, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentPresetSeatInjected, AgentPresetSeatProps,
} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export function visibleModes<T extends { id: string }>(options: readonly T[]): T[] {
  return options.filter(option => option.id === 'standard' || option.id === 'design')
}

export function ModePicker({ component: Component, ...props }: AgentPresetSeatProps & { component: ComponentType<AgentPresetSeatProps> }) {
  const useModes: AgentPresetSeatProps['useAgentPresetSeat'] = useCallback((selector, equal) =>
    props.useAgentPresetSeat(state => selector({ ...state, options: visibleModes(state.options) }), equal),
  [props.useAgentPresetSeat])
  return <Component {...props} useAgentPresetSeat={useModes} />
}

// Shadow only the presentation seats through the official registry. Keep the
// original controllers, selection lifecycle and backend roster for old sessions.
export function applyModePicker(ctx: Context): void {
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
    return () => {
      seatSubscription()
      stopSeat?.()
    }
  }, 'starweave: standard and design mode choices')
}
