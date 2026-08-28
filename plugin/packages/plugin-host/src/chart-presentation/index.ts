import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type {
  ChartCartesianPayload,
  ChartFunnelPayload,
  ChartHeatmapPayload,
  ChartPresentationModel,
  ChartPresentationPayload,
  ChartPresentationSeries,
  ChartPresentationView,
  ChartSankeyLink,
  ChartSankeyPayload,
  ChartTableCell,
  ChartTablePayload,
} from '../shared/types.ts'

export const name = 'desktop-chart-presentation'
export const inject = ['tools']

export const CHART_PRESENTATION_MARKER = '[DSH_CHART_PRESENTATION_V1]'

const VIEWS: readonly ChartPresentationView[] = ['line', 'bar', 'funnel', 'heatmap', 'sankey', 'table']
const MAX_LABELS = 500
const MAX_SERIES = 8
const MAX_FUNNEL_STEPS = 20
const MAX_TABLE_COLUMNS = 16
const MAX_TABLE_ROWS = 200
const MAX_HEATMAP_ROWS = 60
const MAX_HEATMAP_COLUMNS = 60
const MAX_SANKEY_LINKS = 200
const MAX_TEXT_LENGTH = 160
const MAX_CELL_LENGTH = 500

interface ChartPresentationInput {
  readonly view: ChartPresentationView
  readonly title: string
  readonly payload: unknown
  readonly source?: string
  readonly generated_at?: string
  readonly truncated?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, expectation: string): never {
  throw new Error(`${path} ${expectation}`)
}

function text(value: unknown, path: string, { allowEmpty = true, limit = MAX_TEXT_LENGTH } = {}): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (!allowEmpty && value.trim().length === 0) fail(path, 'must not be empty')
  if (value.length > limit) fail(path, `must contain at most ${String(limit)} characters`)
  return value
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number')
  return value
}

function stringArray(value: unknown, path: string, limit: number): readonly string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > limit) fail(path, `must contain at most ${String(limit)} items`)
  return value.map((entry, index) => text(entry, `${path}[${String(index)}]`))
}

function numericArray(value: unknown, path: string, expectedLength?: number): readonly (number | null)[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (expectedLength !== undefined && value.length !== expectedLength) {
    fail(path, `must contain exactly ${String(expectedLength)} items`)
  }
  return value.map((entry, index) => entry === null ? null : finiteNumber(entry, `${path}[${String(index)}]`))
}

function cartesianPayload(value: unknown): ChartCartesianPayload {
  if (!isRecord(value)) fail('payload', 'must be an object')
  const labels = stringArray(value.labels, 'payload.labels', MAX_LABELS)
  if (!Array.isArray(value.series)) fail('payload.series', 'must be an array')
  if (value.series.length > MAX_SERIES) fail('payload.series', `must contain at most ${String(MAX_SERIES)} items`)
  const series: ChartPresentationSeries[] = value.series.map((entry, index) => {
    const path = `payload.series[${String(index)}]`
    if (!isRecord(entry)) fail(path, 'must be an object')
    if (entry.format !== undefined && entry.format !== 'number' && entry.format !== 'percent') {
      fail(`${path}.format`, 'must be number or percent')
    }
    const format: 'number' | 'percent' | undefined = entry.format
    return {
      name: text(entry.name, `${path}.name`, { allowEmpty: false }),
      values: numericArray(entry.values, `${path}.values`, labels.length),
      ...(format === undefined ? {} : { format }),
    }
  })
  return { labels, series }
}

function funnelPayload(value: unknown): ChartFunnelPayload {
  if (!isRecord(value) || !Array.isArray(value.steps)) fail('payload.steps', 'must be an array')
  if (value.steps.length > MAX_FUNNEL_STEPS) {
    fail('payload.steps', `must contain at most ${String(MAX_FUNNEL_STEPS)} items`)
  }
  return {
    steps: value.steps.map((entry, index) => {
      const path = `payload.steps[${String(index)}]`
      if (!isRecord(entry)) fail(path, 'must be an object')
      return {
        label: text(entry.label, `${path}.label`, { allowEmpty: false }),
        value: finiteNumber(entry.value, `${path}.value`),
      }
    }),
  }
}

function heatmapPayload(value: unknown): ChartHeatmapPayload {
  if (!isRecord(value)) fail('payload', 'must be an object')
  const columns = stringArray(value.columns, 'payload.columns', MAX_HEATMAP_COLUMNS)
  if (value.format !== 'number' && value.format !== 'percent') fail('payload.format', 'must be number or percent')
  if (!Array.isArray(value.rows)) fail('payload.rows', 'must be an array')
  if (value.rows.length > MAX_HEATMAP_ROWS) fail('payload.rows', `must contain at most ${String(MAX_HEATMAP_ROWS)} items`)
  const rows = value.rows.map((entry, index) => {
    const path = `payload.rows[${String(index)}]`
    if (!isRecord(entry)) fail(path, 'must be an object')
    return {
      label: text(entry.label, `${path}.label`, { allowEmpty: false }),
      ...(entry.initial === undefined ? {} : { initial: finiteNumber(entry.initial, `${path}.initial`) }),
      values: numericArray(entry.values, `${path}.values`, columns.length),
    }
  })
  return { columns, rows, format: value.format }
}

function hasDirectedCycle(links: readonly ChartSankeyLink[]): boolean {
  const edges = new Map<string, string[]>()
  for (const link of links) edges.set(link.source, [...(edges.get(link.source) ?? []), link.target])
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true
    if (visited.has(node)) return false
    visiting.add(node)
    for (const target of edges.get(node) ?? []) if (visit(target)) return true
    visiting.delete(node)
    visited.add(node)
    return false
  }
  return [...edges.keys()].some(visit)
}

function sankeyPayload(value: unknown): ChartSankeyPayload {
  if (!isRecord(value) || !Array.isArray(value.links)) fail('payload.links', 'must be an array')
  if (value.links.length > MAX_SANKEY_LINKS) fail('payload.links', `must contain at most ${String(MAX_SANKEY_LINKS)} items`)
  const links = value.links.map((entry, index) => {
    const path = `payload.links[${String(index)}]`
    if (!isRecord(entry)) fail(path, 'must be an object')
    const source = text(entry.source, `${path}.source`, { allowEmpty: false })
    const target = text(entry.target, `${path}.target`, { allowEmpty: false })
    if (source === target) fail(path, 'must connect two different nodes')
    const amount = finiteNumber(entry.value, `${path}.value`)
    if (amount < 0) fail(`${path}.value`, 'must be greater than or equal to zero')
    return { source, target, value: amount }
  })
  if (hasDirectedCycle(links)) fail('payload.links', 'must form an acyclic directed graph')
  return { links }
}

function tableCell(value: unknown, path: string): ChartTableCell {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return finiteNumber(value, path)
  return text(value, path, { limit: MAX_CELL_LENGTH })
}

function tablePayload(value: unknown): ChartTablePayload {
  if (!isRecord(value)) fail('payload', 'must be an object')
  const columns = stringArray(value.columns, 'payload.columns', MAX_TABLE_COLUMNS)
  if (!Array.isArray(value.rows)) fail('payload.rows', 'must be an array')
  if (value.rows.length > MAX_TABLE_ROWS) fail('payload.rows', `must contain at most ${String(MAX_TABLE_ROWS)} items`)
  const rows = value.rows.map((entry, rowIndex) => {
    const path = `payload.rows[${String(rowIndex)}]`
    if (!Array.isArray(entry)) fail(path, 'must be an array')
    if (entry.length !== columns.length) fail(path, `must contain exactly ${String(columns.length)} cells`)
    return entry.map((cell, columnIndex) => tableCell(cell, `${path}[${String(columnIndex)}]`))
  })
  return { columns, rows }
}

function normalizePayload(view: ChartPresentationView, payload: unknown): ChartPresentationPayload {
  switch (view) {
    case 'line':
    case 'bar': return cartesianPayload(payload)
    case 'funnel': return funnelPayload(payload)
    case 'heatmap': return heatmapPayload(payload)
    case 'sankey': return sankeyPayload(payload)
    case 'table': return tablePayload(payload)
  }
}

/** Validate agent-authored chart data and return the durable UI contract. */
export function buildChartPresentation(input: ChartPresentationInput): ChartPresentationModel {
  if (!VIEWS.includes(input.view)) fail('view', `must be one of ${VIEWS.join(', ')}`)
  const title = text(input.title, 'title', { allowEmpty: false })
  const source = input.source === undefined ? undefined : text(input.source, 'source', { allowEmpty: false })
  const generatedAt = input.generated_at === undefined ? undefined : text(input.generated_at, 'generated_at', { allowEmpty: false })
  return {
    schemaVersion: 1,
    view: input.view,
    title,
    ...(source === undefined ? {} : { source }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    truncated: input.truncated ?? false,
    payload: normalizePayload(input.view, input.payload),
  }
}

function presentationTool() {
  return defineTool({
    name: 'chart_present',
    description: [
      'Render agent-prepared data as an in-conversation chart or table.',
      'Use only when a visual materially improves comprehension; explain the conclusion in the final response as well.',
      'Payload shapes: line/bar {labels:string[],series:[{name,values:(number|null)[],format?:number|percent}]};',
      'funnel {steps:[{label,value}]}; heatmap {columns:string[],rows:[{label,initial?:number,values:(number|null)[]}],format:number|percent};',
      'sankey {links:[{source,target,value}]} using an acyclic graph; table {columns:string[],rows:(string|number|boolean|null)[][]}.',
      'Values must already be computed from real tool results. Do not invent, interpolate, or copy more data than the limits require.',
    ].join(' '),
    parameters: {
      view: { type: 'string', required: true, enum: VIEWS, description: 'Chart type that matches the prepared payload shape.' },
      title: { type: 'string', required: true, description: 'Short title describing the chart and analysis scope.' },
      payload: { type: 'json', required: true, description: 'Prepared chart data using the shape documented for the selected view.' },
      source: { type: 'string', description: 'Optional human-readable source or tool label shown with the chart.' },
      generated_at: { type: 'string', description: 'Optional source result timestamp or reporting period.' },
      truncated: { type: 'boolean', description: 'Set true when source data was intentionally limited for display.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemaVersion: { type: 'integer', required: true },
          view: { type: 'string', required: true, enum: VIEWS },
          title: { type: 'string', required: true },
          source: { type: 'string' },
          generatedAt: { type: 'string' },
          truncated: { type: 'boolean', required: true },
          payload: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Prepared ${value.view} chart${value.source === undefined ? '' : ` from ${value.source}`}.` }],
      presentationMeta: (_args, value) => value,
    },
    finalizeContent(exec, result) {
      if (exec.parent === undefined || result.isError) return undefined
      return [{ type: 'text', text: `Prepared nested chart.\n${CHART_PRESENTATION_MARKER}${JSON.stringify(result.value)}` }]
    },
    async execute(args) {
      const model = buildChartPresentation(args)
      return { ...model, payload: model.payload as unknown as JsonValue }
    },
  })
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(presentationTool()), 'desktop-chart-presentation: tool')
  ctx.get('systemPrompt')?.section({
    name: 'desktop-chart-presentation',
    order: 82,
    text: [
      'Use chart_present when a chart or bounded table materially improves an answer based on real data.',
      'Choose the matching payload schema described by the tool, preserve nulls for missing values, and set truncated when display limits omit source rows or series.',
      'The chart is supporting evidence; still explain the conclusion, source, scope, and important caveats in the final response.',
    ].join(' '),
  })
}
