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
  ChartPresentationCard,
  presentationFromBlock,
  type ChartPresentationCardProps,
} from '../src/client/chart-presentation/ChartPresentationCard.tsx'
import { chartPresentationEn } from '../src/client/locales.ts'
import type { ChartPresentationModel } from '@run-bigpig/dsh-desktop-plugin-host/types'

const MARKER = '[DSH_CHART_PRESENTATION_V1]'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function translate(key: keyof typeof chartPresentationEn, params?: Readonly<Record<string, unknown>>): string {
  let value = chartPresentationEn[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}

const model: ChartPresentationModel = {
  schemaVersion: 1,
  view: 'line',
  title: 'Daily active users',
  source: 'analytics_query',
  generatedAt: '2026-08-28 10:00:00',
  truncated: true,
  payload: {
    labels: ['2026-08-27', '2026-08-28'],
    series: [{ name: 'Users', values: [120, 180] }],
  },
}

function settled(meta: unknown = model, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: 'tool-result',
    seq: 4,
    time: Date.now(),
    callId: 'call-1',
    call: { name: 'chart_present', argsRaw: '{}' },
    callTime: Date.now() - 10,
    content: [{ type: 'text', text: 'Prepared chart.' }],
    isError: false,
    meta,
    callView: null,
    resultView: null,
    subCalls: [],
    ...overrides,
  }
}

function props(block: unknown, inspect = vi.fn()): ChartPresentationCardProps {
  return { block, inspect, toolName: 'chart_present', t: translate } as unknown as ChartPresentationCardProps
}

describe('general chart presentation card', () => {
  it('shows a generic running state before chart_present settles', () => {
    const running = {
      callId: 'call-1', name: 'chart_present', argsRaw: '{}', turn: 1, step: 1,
      time: Date.now(), callView: null, subCalls: [],
    }
    const view = render(<ChartPresentationCard {...props(running)} />)
    expect(view.getByText('Preparing visualization')).toBeTruthy()
    expect(view.getByText(/chart interface/)).toBeTruthy()
  })

  it('renders metadata, chart, and the bounded data table', () => {
    const inspect = vi.fn()
    const view = render(<ChartPresentationCard {...props(settled(), inspect)} />)

    expect(view.getByText('Daily active users')).toBeTruthy()
    expect(view.getByText('analytics_query')).toBeTruthy()
    expect(view.getByText('Display limited')).toBeTruthy()
    expect(view.getByRole('img', { name: 'Daily active users chart' })).toBeTruthy()
    expect(view.container.querySelector('[data-antv="line"]')?.getAttribute('data-count')).toBe('2')
    fireEvent.click(view.getByRole('tab', { name: 'Data' }))
    expect(view.getByRole('region', { name: 'Daily active users data table' })).toBeTruthy()
    expect(view.getByText('180')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Inspect call' }))
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('renders heatmap and Sankey payloads from the common interface', () => {
    const heatmap: ChartPresentationModel = {
      ...model,
      view: 'heatmap',
      source: undefined,
      title: 'Retention',
      truncated: false,
      payload: {
        columns: ['D0', 'D1'],
        rows: [{ label: '2026-08-28', initial: 100, values: [100, 42] }],
        format: 'percent',
      },
    }
    const heatmapView = render(<ChartPresentationCard {...props(settled(heatmap))} />)
    expect(heatmapView.getByText('Agent prepared')).toBeTruthy()
    expect(heatmapView.container.querySelector('[data-antv="heatmap"]')?.getAttribute('data-count')).toBe('2')
    cleanup()

    const sankey: ChartPresentationModel = {
      ...model,
      view: 'sankey',
      title: 'Request flow',
      truncated: false,
      payload: { links: [{ source: 'Input', target: 'Output', value: 12 }] },
    }
    const sankeyView = render(<ChartPresentationCard {...props(settled(sankey))} />)
    expect(sankeyView.container.querySelector('[data-antv="sankey"]')?.getAttribute('data-count')).toBe('1')
  })

  it('recovers nested chart calls from the durable marker', () => {
    const nested = settled(undefined, {
      content: [{ type: 'text', text: `Prepared nested chart.\n${MARKER}${JSON.stringify(model)}` }],
    })
    expect(presentationFromBlock(nested as never)).toEqual(model)
    expect(render(<ChartPresentationCard {...props(nested)} />).getByRole('img', { name: 'Daily active users chart' })).toBeTruthy()
  })

  it('shows failures and rejects malformed or oversized metadata', () => {
    const failed = settled(undefined, {
      isError: true,
      content: [{ type: 'text', text: 'payload.series[0].values must contain exactly 2 items' }],
      error: { name: 'Error', code: 'INVALID_CHART' },
    })
    expect(render(<ChartPresentationCard {...props(failed)} />).getByRole('alert').textContent).toContain('exactly 2 items')
    cleanup()

    const oversized = {
      ...model,
      payload: { labels: Array.from({ length: 501 }, () => 'x'), series: [] },
    }
    const invalidBlock = settled(oversized)
    expect(presentationFromBlock(invalidBlock as never)).toBeUndefined()
    expect(render(<ChartPresentationCard {...props(invalidBlock)} />).getByRole('alert').textContent).toContain('Unrecognized presentation result')
  })
})
