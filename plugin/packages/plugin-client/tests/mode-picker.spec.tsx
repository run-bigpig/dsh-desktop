// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPresetSeatProps, AgentPresetSeatState } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { ModePicker } from '../src/client/design/mode-picker.tsx'

afterEach(cleanup)

it('filters mode choices while preserving the official selection action and live state', () => {
  let state: AgentPresetSeatState = {
    current: 'standard', busy: false, error: null, introduce: false,
    options: ['standard', 'minimal', 'ptc', 'cordis', 'design', 'custom'].map(id => ({ id, trust: 'system' as const })),
  }
  const notify = new Set<() => void>()
  const subscribe = (fn: () => void) => { notify.add(fn); return () => { notify.delete(fn) } }
  const select = vi.fn(async (id: string) => { state = { ...state, current: id }; notify.forEach(fn => fn()); return undefined })
  const useAgentPresetSeat: AgentPresetSeatProps['useAgentPresetSeat'] = selector => selector(useSyncExternalStore(subscribe, () => state))
  function OfficialSeat(props: AgentPresetSeatProps) {
    const snapshot = props.useAgentPresetSeat(value => value)
    return <><output>{snapshot.current}</output>{snapshot.options.map(option => <button key={option.id} onClick={() => void props.select(option.id)}>{option.id}</button>)}</>
  }
  render(<ModePicker component={OfficialSeat} {...{ useAgentPresetSeat, select } as AgentPresetSeatProps} />)
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['standard', 'design'])
  act(() => fireEvent.click(screen.getByRole('button', { name: 'design' })))
  expect(select).toHaveBeenCalledWith('design')
  expect(screen.getByRole('status').textContent).toBe('design')
  expect(state.options).toHaveLength(6)
})
