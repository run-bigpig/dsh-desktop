import { describe, expect, it } from 'vitest'
import { buildChartPresentation } from '../src/chart-presentation.ts'
import type {
  ChartCartesianPayload,
  ChartHeatmapPayload,
  ChartSankeyPayload,
  ChartTablePayload,
} from '../src/types.ts'

describe('general chart presentation contract', () => {
  it('accepts agent-prepared cartesian data without a TA source dependency', () => {
    const model = buildChartPresentation({
      view: 'line',
      title: 'Weekly active users',
      source: 'analytics_query',
      generated_at: '2026-08-28',
      truncated: true,
      payload: {
        labels: ['Mon', 'Tue', 'Wed'],
        series: [
          { name: 'Users', values: [120, 180, null] },
          { name: 'Conversion', values: [12.5, 14.2, 13.8], format: 'percent' },
        ],
      },
    })

    expect(model).toMatchObject({
      schemaVersion: 1,
      view: 'line',
      source: 'analytics_query',
      generatedAt: '2026-08-28',
      truncated: true,
    })
    expect((model.payload as ChartCartesianPayload).series[1]?.format).toBe('percent')
  })

  it('accepts funnel, heatmap, Sankey, and table payloads', () => {
    expect(buildChartPresentation({
      view: 'funnel', title: 'Signup funnel',
      payload: { steps: [{ label: 'Visit', value: 1000 }, { label: 'Signup', value: 320 }] },
    }).payload).toEqual({ steps: [{ label: 'Visit', value: 1000 }, { label: 'Signup', value: 320 }] })

    const heatmap = buildChartPresentation({
      view: 'heatmap', title: 'Retention',
      payload: {
        columns: ['D0', 'D1'],
        rows: [{ label: '2026-08-27', initial: 100, values: [100, 42] }],
        format: 'percent',
      },
    }).payload as ChartHeatmapPayload
    expect(heatmap.rows[0]?.values).toEqual([100, 42])

    const sankey = buildChartPresentation({
      view: 'sankey', title: 'Request flow',
      payload: { links: [{ source: 'Input', target: 'Model', value: 12 }, { source: 'Model', target: 'Output', value: 10 }] },
    }).payload as ChartSankeyPayload
    expect(sankey.links).toHaveLength(2)

    const table = buildChartPresentation({
      view: 'table', title: 'Summary',
      payload: { columns: ['Metric', 'Value'], rows: [['Users', 320], ['Healthy', true]] },
    }).payload as ChartTablePayload
    expect(table.rows[1]).toEqual(['Healthy', true])
  })

  it('requires values to match the selected chart interface', () => {
    expect(() => buildChartPresentation({
      view: 'bar', title: 'Broken',
      payload: { labels: ['A', 'B'], series: [{ name: 'Count', values: [1] }] },
    })).toThrow('payload.series[0].values must contain exactly 2 items')

    expect(() => buildChartPresentation({
      view: 'table', title: 'Broken',
      payload: { columns: ['A', 'B'], rows: [[1]] },
    })).toThrow('payload.rows[0] must contain exactly 2 cells')
  })

  it('enforces display bounds and rejects cyclic Sankey data', () => {
    expect(() => buildChartPresentation({
      view: 'line', title: 'Too many labels',
      payload: { labels: Array.from({ length: 501 }, (_, index) => String(index)), series: [] },
    })).toThrow('payload.labels must contain at most 500 items')

    expect(() => buildChartPresentation({
      view: 'sankey', title: 'Cycle',
      payload: { links: [{ source: 'A', target: 'B', value: 1 }, { source: 'B', target: 'A', value: 1 }] },
    })).toThrow('payload.links must form an acyclic directed graph')
  })

  it('accepts empty bounded datasets so the client can render an empty state', () => {
    const model = buildChartPresentation({
      view: 'bar', title: 'No matching records', payload: { labels: [], series: [] },
    })
    expect(model.truncated).toBe(false)
    expect('source' in model).toBe(false)
    expect(model.payload).toEqual({ labels: [], series: [] })
  })
})
