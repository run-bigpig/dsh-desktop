import { describe, expect, it } from 'vitest'
import { buildTaPresentation, extractTaResult } from '../src/ta-presentation.ts'
import type { TaCartesianPayload, TaFunnelPayload, TaHeatmapPayload, TaSankeyPayload, TaTablePayload } from '../src/types.ts'

describe('TA presentation adapter', () => {
  it('prefers the MCP structured result and falls back to rendered JSON text', () => {
    const result = { return_code: 0, data: { x: ['2026-08-20'], y: { users: [12] } } }

    expect(extractTaResult({ structuredContent: { result }, content: [] })).toEqual(result)
    expect(extractTaResult(undefined, [{ type: 'text', text: JSON.stringify(result) }])).toEqual(result)
  })

  it('maps event analysis to a bounded line chart using the real result values', () => {
    const labels = Array.from({ length: 501 }, (_, index) => `2026-08-${String(index + 1)}`)
    const values = Array.from({ length: 501 }, (_, index) => index)
    const model = buildTaPresentation('mcp__thinkingdata__ta_event_analyze', {
      return_code: 0,
      data: { x: labels, y: { active_users: values }, result_generate_time: '2026-08-21 10:00:00' },
    }, 'auto', '活跃用户趋势')
    const payload = model.payload as TaCartesianPayload

    expect(model).toMatchObject({ view: 'line', sourceTool: 'ta_event_analyze', truncated: true })
    expect(model.generatedAt).toBe('2026-08-21 10:00:00')
    expect(payload.labels).toHaveLength(500)
    expect(payload.series[0]?.values).toEqual(values.slice(0, 500))
  })

  it('maps funnel and retention responses without agent-supplied data', () => {
    const funnel = buildTaPresentation('ta_funnel_analyze', {
      return_code: 0,
      data: { z: ['访问', '注册', '付费'], y: { users: [1000, 460, 92] } },
    }, 'auto')
    expect((funnel.payload as TaFunnelPayload).steps).toEqual([
      { label: '访问', value: 1000 },
      { label: '注册', value: 460 },
      { label: '付费', value: 92 },
    ])

    const retention = buildTaPresentation('ta_retention_analyze', {
      return_code: 0,
      data: {
        x: ['2026-08-19', '2026-08-20'],
        y: { retention: {
          '2026-08-19': { initNum: 100, values: [1, 0.5, '25%'] },
          '2026-08-20': { initNum: 80, values: [1, 0.4] },
        } },
      },
    }, 'auto')
    const heatmap = retention.payload as TaHeatmapPayload
    expect(retention).toMatchObject({ view: 'heatmap', truncated: false })
    expect(heatmap.columns).toEqual(['D0', 'D1', 'D2'])
    expect(heatmap.rows[0]).toEqual({ label: '2026-08-19', initial: 100, values: [100, 50, 25] })
  })

  it('maps the current TA retention response arrays and count values to percentages', () => {
    const retention = buildTaPresentation('mcp__ta-mcp-server__ta_retention_analyze', {
      return_code: 0,
      data: {
        x: ['2026-08-16', '2026-08-17'],
        y: {
          0: {
            '2026-08-16': [{
              groupCols: [], includeToday: true, initNum: 1201, invalidIndex: 10, isTotal: 1,
              values: ['1201', '1201', '683', '643'],
            }],
            '2026-08-17': [{
              groupCols: [], includeToday: true, initNum: 1164, invalidIndex: 9, isTotal: 1,
              values: ['1164', '1164', '689', '-'],
            }],
          },
          1: {
            '2026-08-16': [{ initNum: 1201, isTotal: 1, values: ['1201', '1201', '518', '385'] }],
          },
        },
      },
    }, 'auto')
    const heatmap = retention.payload as TaHeatmapPayload

    expect(retention).toMatchObject({ view: 'heatmap', sourceTool: 'ta_retention_analyze' })
    expect(heatmap.columns).toEqual(['D0', 'D1', 'D2'])
    expect(heatmap.rows[0]).toEqual({
      label: '2026-08-16', initial: 1201, values: [100, 683 / 1201 * 100, 643 / 1201 * 100],
    })
    expect(heatmap.rows[1]).toEqual({
      label: '2026-08-17', initial: 1164, values: [100, 689 / 1164 * 100, null],
    })
  })

  it('maps path analysis links and weighted path sequences to a bounded Sankey graph', () => {
    const direct = buildTaPresentation('ta_path_analyze', {
      return_code: 0,
      data: { links: [
        { source: '首页', target: '商品页', value: 30 },
        { source: '首页', target: '商品页', count: 12 },
        { source: '商品页', target: '支付', user_count: 8 },
      ] },
    }, 'auto')
    expect(direct).toMatchObject({ view: 'sankey', truncated: false })
    expect((direct.payload as TaSankeyPayload).links).toEqual([
      { source: '首页', target: '商品页', value: 42 },
      { source: '商品页', target: '支付', value: 8 },
    ])

    const sequences = buildTaPresentation('ta_path_analyze', {
      return_code: 0,
      data: { userEventSeqList: [
        { path: ['启动', '浏览', '购买'], count: 10 },
        { eventSequence: [{ eventName: '启动' }, { event_name: '浏览' }, { name: '购买' }], users: 5 },
      ] },
    }, 'auto')
    expect((sequences.payload as TaSankeyPayload).links).toEqual([
      { source: '1. 启动', target: '2. 浏览', value: 15 },
      { source: '2. 浏览', target: '3. 购买', value: 15 },
    ])
  })

  it('limits Sankey links and falls back to a table for unrecognized path data', () => {
    const links = Array.from({ length: 205 }, (_, index) => ({
      source: `source-${String(index)}`,
      target: `target-${String(index)}`,
      value: index + 1,
    }))
    const bounded = buildTaPresentation('ta_path_analyze', { return_code: 0, data: { links } }, 'auto')
    expect(bounded).toMatchObject({ view: 'sankey', truncated: true })
    expect((bounded.payload as TaSankeyPayload).links).toHaveLength(200)

    const fallback = buildTaPresentation('ta_path_analyze', {
      return_code: 0,
      data: { userEventSeqList: [{ label: 'not a path', total: 12 }] },
    }, 'auto')
    expect(fallback.view).toBe('table')

    const cyclic = buildTaPresentation('ta_path_analyze', {
      return_code: 0,
      data: { links: [
        { source: 'A', target: 'B', value: 10 },
        { source: 'B', target: 'A', value: 5 },
      ] },
    }, 'auto')
    expect(cyclic.view).toBe('table')
  })

  it('falls back to a bounded table and rejects TA query errors', () => {
    const records = Array.from({ length: 205 }, (_, row) => Object.fromEntries(
      Array.from({ length: 18 }, (_, column) => [`column-${String(column)}`, column === 0 ? 'x'.repeat(700) : row * 100 + column]),
    ))
    const model = buildTaPresentation('ta_sql_query', { return_code: 0, data: { data_list: records } }, 'auto')
    const table = model.payload as TaTablePayload

    expect(model).toMatchObject({ view: 'table', truncated: true })
    expect(table.columns).toHaveLength(16)
    expect(table.rows).toHaveLength(200)
    expect(String(table.rows[0]?.[0])).toHaveLength(500)
    expect(() => buildTaPresentation('ta_event_analyze', {
      return_code: 400,
      return_message: 'invalid query',
    }, 'auto')).toThrow('TA query failed (400): invalid query')
  })
})
