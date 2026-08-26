// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@ant-design/plots', () => {
  const plot = (name: string) => (props: { readonly data?: readonly unknown[] }) => (
    <div data-antv={name} data-count={props.data?.length ?? 0} />
  )
  return {
    Bar: plot('bar'),
    Funnel: plot('funnel'),
    Heatmap: plot('heatmap'),
    Line: plot('line'),
    Sankey: plot('sankey'),
  }
})

import {
  presentationFromBlock,
  TaPresentationCard,
  type TaPresentationCardProps,
} from '../src/client/TaPresentationCard.tsx'
import { taPresentationEn } from '../src/client/locales.ts'
import type { TaPresentationModel } from '@run-bigpig/dsh-desktop-plugin-host/types'

const MARKER = '[DSH_TA_PRESENTATION_V1]'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function translate(key: keyof typeof taPresentationEn, params?: Readonly<Record<string, unknown>>): string {
  let text = taPresentationEn[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

const model: TaPresentationModel = {
  schemaVersion: 1,
  view: 'line',
  title: 'Daily active users',
  sourceTool: 'ta_event_analyze',
  generatedAt: '2026-08-21 10:00:00',
  truncated: true,
  payload: {
    labels: ['2026-08-19', '2026-08-20'],
    series: [{ name: 'Users', values: [120, 180] }],
  },
}

function settled(meta: unknown = model, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: 'tool-result',
    seq: 4,
    time: Date.now(),
    callId: 'call-1',
    call: { name: 'ta_present', argsRaw: '{}' },
    callTime: Date.now() - 10,
    content: [{ type: 'text', text: 'Prepared presentation.' }],
    isError: false,
    meta,
    callView: null,
    resultView: null,
    subCalls: [],
    ...overrides,
  }
}

function props(block: unknown, inspect = vi.fn(), toolName = 'ta_present'): TaPresentationCardProps {
  return { block, inspect, toolName, t: translate } as unknown as TaPresentationCardProps
}

describe('TA presentation card', () => {
  it('shows the running state before ta_present settles', () => {
    const running = {
      callId: 'call-1', name: 'ta_present', argsRaw: '{}', turn: 1, step: 1,
      time: Date.now(), callView: null, subCalls: [],
    }
    const view = render(<TaPresentationCard {...props(running)} />)

    expect(view.getByText('Preparing visualization')).toBeTruthy()
    expect(view.getByText(/Preparing the real query result/)).toBeTruthy()
  })

  it('renders metadata through the chart view and exposes the bounded data table', () => {
    const inspect = vi.fn()
    const view = render(<TaPresentationCard {...props(settled(), inspect)} />)

    expect(view.getByText('Daily active users')).toBeTruthy()
    expect(view.getByText('Display limited')).toBeTruthy()
    expect(view.getByRole('img', { name: 'Daily active users chart' })).toBeTruthy()
    expect(view.container.querySelector('[data-antv="line"]')?.getAttribute('data-count')).toBe('2')
    fireEvent.click(view.getByRole('tab', { name: 'Data' }))
    expect(view.getByRole('region', { name: 'Daily active users data table' })).toBeTruthy()
    expect(view.getByText('180')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Inspect call' }))
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('renders retention and path presentations with AntV Heatmap and Sankey', () => {
    const retention: TaPresentationModel = {
      ...model,
      view: 'heatmap',
      title: 'Retention',
      sourceTool: 'ta_retention_analyze',
      truncated: false,
      payload: {
        columns: ['D0', 'D1'],
        rows: [{ label: '2026-08-20', initial: 100, values: [100, 42] }],
        format: 'percent',
      },
    }
    const retentionView = render(<TaPresentationCard {...props(settled(retention))} />)
    expect(retentionView.container.querySelector('[data-antv="heatmap"]')?.getAttribute('data-count')).toBe('2')
    cleanup()

    const path: TaPresentationModel = {
      ...model,
      view: 'sankey',
      title: 'User paths',
      sourceTool: 'ta_path_analyze',
      truncated: false,
      payload: { links: [{ source: '1. Home', target: '2. Buy', value: 12 }] },
    }
    const pathView = render(<TaPresentationCard {...props(settled(path))} />)
    expect(pathView.container.querySelector('[data-antv="sankey"]')?.getAttribute('data-count')).toBe('1')
    fireEvent.click(pathView.getByRole('tab', { name: 'Data' }))
    expect(pathView.getByText('1. Home')).toBeTruthy()
  })

  it('renders the current TA MCP retention result directly as a heatmap', () => {
    const result = {
      return_code: 0,
      data: {
        x: ['2026-08-16', '2026-08-17'],
        y: { 0: {
          '2026-08-16': [{ initNum: 1201, invalidIndex: 10, isTotal: 1, values: ['1201', '1201', '683'] }],
          '2026-08-17': [{ initNum: 1164, invalidIndex: 9, isTotal: 1, values: ['1164', '1164', '689'] }],
        } },
        result_generate_time: '2026-08-25 14:05:10',
      },
    }
    const direct = settled(null, {
      call: { name: 'mcp__ta-mcp-server__ta_retention_analyze', argsRaw: '{}' },
      content: [{ type: 'text', text: JSON.stringify(result) }],
    })
    const toolName = 'mcp__ta-mcp-server__ta_retention_analyze'

    expect(presentationFromBlock(direct as never, toolName)).toMatchObject({
      view: 'heatmap', sourceTool: 'ta_retention_analyze', generatedAt: '2026-08-25 14:05:10',
    })
    const view = render(<TaPresentationCard {...props(direct, vi.fn(), toolName)} />)
    expect(view.container.querySelector('[data-antv="heatmap"]')?.getAttribute('data-count')).toBe('4')
  })

  it('recovers nested Code Mode presentations from the durable marker', () => {
    const nested = settled(undefined, {
      content: [{ type: 'text', text: `Prepared presentation.\n${MARKER}${JSON.stringify(model)}` }],
    })

    expect(presentationFromBlock(nested as never)).toEqual(model)
    const view = render(<TaPresentationCard {...props(nested)} />)
    expect(view.getByRole('img', { name: 'Daily active users chart' })).toBeTruthy()
  })

  it('shows tool failures and rejects malformed or oversized metadata', () => {
    const failed = settled(undefined, {
      isError: true,
      content: [{ type: 'text', text: 'No matching TA result.' }],
      error: { name: 'Error', code: 'NO_SOURCE' },
    })
    const failureView = render(<TaPresentationCard {...props(failed)} />)
    expect(failureView.getByRole('alert').textContent).toContain('No matching TA result.')
    cleanup()

    const oversized = {
      ...model,
      payload: { labels: Array.from({ length: 501 }, () => 'x'), series: [] },
    }
    const invalidBlock = settled(oversized)
    expect(presentationFromBlock(invalidBlock as never)).toBeUndefined()
    const invalidView = render(<TaPresentationCard {...props(invalidBlock)} />)
    expect(invalidView.getByRole('alert').textContent).toContain('Unrecognized presentation result')
    cleanup()

    const oversizedSankey = {
      ...model,
      view: 'sankey',
      payload: {
        links: Array.from({ length: 201 }, (_, index) => ({ source: `s${String(index)}`, target: `t${String(index)}`, value: 1 })),
      },
    }
    expect(presentationFromBlock(settled(oversizedSankey) as never)).toBeUndefined()
  })
})
