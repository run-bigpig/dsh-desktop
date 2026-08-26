import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {
  TaCartesianPayload,
  TaFunnelPayload,
  TaHeatmapPayload,
  TaPresentationModel,
  TaPresentationSeries,
  TaPresentationView,
  TaSankeyLink,
  TaSankeyPayload,
  TaTableCell,
  TaTablePayload,
} from './types.ts'

export const name = 'desktop-ta-presentation'
export const inject = ['tools']

export const TA_PRESENTATION_MARKER = '[DSH_TA_PRESENTATION_V1]'

const MAX_CACHE_ENTRIES = 12
const MAX_LABELS = 500
const MAX_SERIES = 8
const MAX_TABLE_COLUMNS = 16
const MAX_TABLE_ROWS = 200
const MAX_HEATMAP_ROWS = 60
const MAX_HEATMAP_COLUMNS = 60
const MAX_SANKEY_LINKS = 200
const MAX_TEXT_LENGTH = 160
const MAX_CELL_LENGTH = 500

const SOURCE_TO_AUTO_VIEW: Readonly<Record<string, TaPresentationView>> = {
  ta_event_analyze: 'line',
  ta_funnel_analyze: 'funnel',
  ta_retention_analyze: 'heatmap',
  ta_path_analyze: 'sankey',
  ta_distribution_analyze: 'bar',
  ta_interval_analyze: 'bar',
  ta_user_property_analyze: 'bar',
}

const DEFAULT_TITLES: Readonly<Record<string, string>> = {
  ta_event_analyze: '事件分析',
  ta_funnel_analyze: '漏斗分析',
  ta_retention_analyze: '留存分析',
  ta_distribution_analyze: '分布分析',
  ta_interval_analyze: '间隔分析',
  ta_path_analyze: '路径分析',
  ta_user_property_analyze: '用户属性分析',
}

interface CachedTaResult {
  readonly sourceTool: string
  readonly result: unknown
  readonly generatedAt?: string
}

interface NumericSeriesCandidate {
  readonly name: string
  readonly values: readonly (number | null)[]
  readonly percent: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clipText(value: string, limit = MAX_TEXT_LENGTH): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function rawToolName(name: string): string {
  const separator = name.lastIndexOf('__')
  return separator < 0 ? name : name.slice(separator + 2)
}

function isTaSourceTool(name: string): boolean {
  const raw = rawToolName(name)
  return raw.startsWith('ta_') && raw !== 'ta_present'
}

function textJson(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return []
    return [block.text]
  }).join('\n').trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Extract the TA server's structured result without retaining the MCP transport wrapper. */
export function extractTaResult(value: unknown, renderedContent?: unknown): unknown {
  if (isRecord(value)) {
    const structured = value.structuredContent
    if (isRecord(structured) && 'result' in structured) return structured.result
    const rawContent = textJson(value.content)
    if (rawContent !== undefined) return rawContent
  }
  return textJson(renderedContent)
}

function generatedAtOf(result: unknown): string | undefined {
  const envelope = isRecord(result) ? result : undefined
  const data = isRecord(envelope?.data) ? envelope.data : envelope
  for (const key of ['result_generate_time', 'resultGenerateTime', 'generated_at']) {
    const value = data?.[key]
    if (typeof value === 'string' && value.length > 0) return clipText(value)
  }
  return undefined
}

function analysisData(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) throw new Error('TA result is not a JSON object')
  if (typeof result.return_code === 'number' && result.return_code !== 0) {
    const message = typeof result.return_message === 'string' ? result.return_message : 'query failed'
    throw new Error(`TA query failed (${String(result.return_code)}): ${message}`)
  }
  return isRecord(result.data) ? result.data : result
}

function parseNumeric(value: unknown): { value: number | null; percent: boolean } {
  if (typeof value === 'number') return { value: Number.isFinite(value) ? value : null, percent: false }
  if (typeof value !== 'string') return { value: null, percent: false }
  const trimmed = value.trim()
  const percent = trimmed.endsWith('%')
  const parsed = Number(percent ? trimmed.slice(0, -1) : trimmed.replaceAll(',', ''))
  return { value: Number.isFinite(parsed) ? parsed : null, percent }
}

function displayLabel(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return clipText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return clipText(String(value))
  return clipText(fallback)
}

function compactPath(path: readonly string[]): string {
  const filtered = path.filter(part => !['data', 'y', 'values', 'intervalData'].includes(part))
  return clipText(filtered.slice(-3).join(' · ') || '指标')
}

function numericSeries(
  root: unknown,
  expectedLength: number,
  percentByDefault = false,
): NumericSeriesCandidate[] {
  const found: NumericSeriesCandidate[] = []
  const visit = (value: unknown, path: string[], depth: number): void => {
    if (found.length >= MAX_SERIES * 3 || depth > 8) return
    if (Array.isArray(value)) {
      if (value.length === expectedLength) {
        const parsed = value.map(parseNumeric)
        if (parsed.some(entry => entry.value !== null)) {
          const values = parsed.map(entry => entry.value)
          const percent = percentByDefault || parsed.some(entry => entry.percent)
          found.push({ name: compactPath(path), values, percent })
          return
        }
      }
      for (const [index, child] of value.entries()) visit(child, [...path, String(index + 1)], depth + 1)
      return
    }
    if (!isRecord(value)) return
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key], depth + 1)
  }
  visit(root, [], 0)
  const unique = new Map<string, NumericSeriesCandidate>()
  for (const candidate of found) {
    const signature = JSON.stringify(candidate.values)
    if (![...unique.values()].some(existing => JSON.stringify(existing.values) === signature)) {
      unique.set(candidate.name || `指标 ${String(unique.size + 1)}`, candidate)
    }
  }
  return [...unique.values()]
}

function normalizePercentSeries(candidate: NumericSeriesCandidate): TaPresentationSeries {
  const finite = candidate.values.filter((value): value is number => value !== null)
  const namedPercent = /(?:rate|ratio|percent|conversion|率|占比|转化)/iu.test(candidate.name)
  const percent = candidate.percent || namedPercent
  const scaleRatio = namedPercent && finite.length > 0 && finite.every(value => value >= 0 && value <= 1)
  return {
    name: candidate.name,
    values: scaleRatio
      ? candidate.values.map(value => value === null ? null : value * 100)
      : candidate.values,
    ...(percent ? { format: 'percent' as const } : {}),
  }
}

function cartesianPayload(data: Record<string, unknown>, sourceTool: string): {
  readonly payload: TaCartesianPayload
  readonly truncated: boolean
} | undefined {
  const labelSource = sourceTool === 'ta_distribution_analyze' && Array.isArray(data.distribution_interval)
    ? data.distribution_interval
    : Array.isArray(data.x) ? data.x : undefined
  if (labelSource === undefined || labelSource.length === 0) return undefined
  const labelCount = Math.min(labelSource.length, MAX_LABELS)
  const labels = labelSource.slice(0, labelCount).map((value, index) => displayLabel(value, String(index + 1)))
  const seriesRoot = data.y ?? data.data_list ?? data.intervalDistributions ?? data.intervalData
  const candidates = numericSeries(seriesRoot, labelSource.length, false)
  if (candidates.length === 0) return undefined
  const ranked = [...candidates].sort((left, right) => {
    const total = (candidate: NumericSeriesCandidate): number => candidate.values.reduce<number>(
      (sum, value) => sum + Math.abs(value ?? 0), 0,
    )
    return total(right) - total(left)
  }).slice(0, MAX_SERIES)
  const series = ranked.map((candidate) => {
    const normalized = normalizePercentSeries(candidate)
    return { ...normalized, values: normalized.values.slice(0, labelCount) }
  })
  return {
    payload: { labels, series },
    truncated: labelSource.length > labelCount || candidates.length > ranked.length,
  }
}

function funnelPayload(data: Record<string, unknown>): {
  readonly payload: TaFunnelPayload
  readonly truncated: boolean
} | undefined {
  if (!Array.isArray(data.z) || data.z.length === 0) return undefined
  const labels = data.z.map((value, index) => displayLabel(value, `步骤 ${String(index + 1)}`))
  const series = numericSeries(data.y, labels.length)[0]
  if (series === undefined) return undefined
  const limit = Math.min(labels.length, 20)
  const steps = labels.slice(0, limit).flatMap((label, index) => {
    const value = series.values[index]
    return value === null || value === undefined ? [] : [{ label, value }]
  })
  return { payload: { steps }, truncated: labels.length > limit }
}

function retentionRows(value: unknown, dates: readonly string[]): {
  readonly rows: TaHeatmapPayload['rows']
  readonly truncated: boolean
} {
  if (!isRecord(value)) return { rows: [], truncated: false }
  type RetentionEntity = Record<string, unknown> & { readonly values: readonly unknown[] }
  const entityOf = (candidate: unknown): RetentionEntity | undefined => {
    if (isRecord(candidate) && Array.isArray(candidate.values)) return candidate as RetentionEntity
    if (!Array.isArray(candidate)) return undefined
    const records = candidate.filter(isRecord)
    const entity = records.find(record => record.isTotal === 1 && Array.isArray(record.values))
      ?? records.find(record => Array.isArray(record.values))
    return entity as RetentionEntity | undefined
  }
  const byDate = [value, ...Object.values(value).filter(isRecord)]
    .find(candidate => dates.some(date => entityOf(candidate[date]) !== undefined))
  if (byDate === undefined) return { rows: [], truncated: false }
  const rows: TaHeatmapPayload['rows'][number][] = []
  let truncated = dates.length > MAX_HEATMAP_ROWS
  for (const date of dates.slice(0, MAX_HEATMAP_ROWS)) {
    const entity = entityOf(byDate[date])
    if (entity === undefined) continue
    const initial = parseNumeric(entity.initNum).value
    const first = parseNumeric(entity.values[0]).value
    const hasLeadingInitial = initial !== null && first === initial && entity.values.length > 1
    const rawValues = hasLeadingInitial ? entity.values.slice(1) : entity.values
    const countValues = initial !== null && initial > 0
      && rawValues.some((raw) => {
        const parsed = parseNumeric(raw)
        return !parsed.percent && (parsed.value ?? 0) > 1
      })
    truncated ||= rawValues.length > MAX_HEATMAP_COLUMNS
    const values = rawValues.slice(0, MAX_HEATMAP_COLUMNS).map((raw) => {
      const parsed = parseNumeric(raw)
      if (parsed.value === null) return null
      if (parsed.percent) return parsed.value
      if (countValues && initial !== null && initial > 0) return parsed.value / initial * 100
      return parsed.value > 1 ? parsed.value : parsed.value * 100
    })
    rows.push({
      label: date,
      ...(initial === null ? {} : { initial }),
      values,
    })
  }
  return { rows, truncated }
}

function heatmapPayload(data: Record<string, unknown>): {
  readonly payload: TaHeatmapPayload
  readonly truncated: boolean
} | undefined {
  if (!Array.isArray(data.x) || !isRecord(data.y)) return undefined
  const dates = data.x.map((value, index) => displayLabel(value, String(index + 1)))
  const mapped = retentionRows(data.y, dates)
  const rows = mapped.rows
  if (rows.length === 0) return undefined
  const width = Math.min(Math.max(...rows.map(row => row.values.length)), MAX_HEATMAP_COLUMNS)
  const columns = Array.from({ length: width }, (_, index) => `D${String(index)}`)
  return {
    payload: { columns, rows, format: 'percent' },
    truncated: mapped.truncated,
  }
}

function finitePositive(value: unknown): number | undefined {
  const parsed = parseNumeric(value).value
  return parsed !== null && parsed > 0 ? parsed : undefined
}

function pathWeight(record: Record<string, unknown>): number {
  for (const key of ['value', 'count', 'user_count', 'userCount', 'users', 'num']) {
    const value = finitePositive(record[key])
    if (value !== undefined) return value
  }
  return 1
}

function pathNode(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return clipText(value.trim())
  if (typeof value === 'number' || typeof value === 'boolean') return clipText(String(value))
  if (!isRecord(value)) return undefined
  for (const key of ['name', 'event', 'event_name', 'eventName', 'label']) {
    const name = value[key]
    if (typeof name === 'string' && name.trim().length > 0) return clipText(name.trim())
  }
  return undefined
}

function directSankeyLink(value: unknown): TaSankeyLink | undefined {
  if (!isRecord(value)) return undefined
  const source = pathNode(value.source)
  const target = pathNode(value.target)
  if (source === undefined || target === undefined || source === target) return undefined
  const weight = pathWeight(value)
  return { source, target, value: weight }
}

function pathSequence(value: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['path', 'events', 'eventSequence', 'event_sequence', 'event_seq', 'sequence']) {
    const sequence = value[key]
    if (!Array.isArray(sequence)) continue
    const nodes = sequence.map(pathNode)
    if (nodes.length >= 2 && nodes.every((node): node is string => node !== undefined)) return nodes
  }
  return undefined
}

function sankeyRecords(data: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(data.links)) return data.links
  for (const key of ['datalist', 'data_list', 'userEventSeqList']) {
    if (Array.isArray(data[key])) return data[key]
  }
  return [data]
}

function hasDirectedCycle(links: readonly TaSankeyLink[]): boolean {
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

function sankeyPayload(data: Record<string, unknown>): {
  readonly payload: TaSankeyPayload
  readonly truncated: boolean
} | undefined {
  const aggregated = new Map<string, TaSankeyLink>()
  const add = (link: TaSankeyLink): void => {
    const key = `${link.source}\u0000${link.target}`
    const existing = aggregated.get(key)
    aggregated.set(key, existing === undefined ? link : { ...existing, value: existing.value + link.value })
  }
  for (const candidate of sankeyRecords(data)) {
    const direct = directSankeyLink(candidate)
    if (direct !== undefined) {
      add(direct)
      continue
    }
    if (!isRecord(candidate)) continue
    const sequence = pathSequence(candidate)
    if (sequence === undefined) continue
    const weight = pathWeight(candidate)
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const source = `${String(index + 1)}. ${sequence[index]}`
      const target = `${String(index + 2)}. ${sequence[index + 1]}`
      add({ source: clipText(source), target: clipText(target), value: weight })
    }
  }
  const links = [...aggregated.values()]
    .sort((left, right) => right.value - left.value)
    .slice(0, MAX_SANKEY_LINKS)
  if (links.length === 0 || hasDirectedCycle(links)) return undefined
  return { payload: { links }, truncated: aggregated.size > links.length }
}

function scalarCell(value: unknown): TaTableCell {
  if (value === undefined) return null
  if (typeof value === 'string') return clipText(value, MAX_CELL_LENGTH)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  const encoded = JSON.stringify(value)
  return clipText(encoded, MAX_CELL_LENGTH)
}

function recordsTable(records: readonly Record<string, unknown>[]): {
  readonly payload: TaTablePayload
  readonly truncated: boolean
} {
  const columnKeys: string[] = []
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!columnKeys.includes(key) && columnKeys.length < MAX_TABLE_COLUMNS) columnKeys.push(key)
    }
  }
  const selected = records.slice(0, MAX_TABLE_ROWS)
  return {
    payload: {
      columns: columnKeys.map(key => clipText(key)),
      rows: selected.map(record => columnKeys.map(key => scalarCell(record[key]))),
    },
    truncated: records.length > selected.length || records.some(record => Object.keys(record).length > columnKeys.length),
  }
}

function parseNdjson(value: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of value.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isRecord(parsed)) records.push(parsed)
    } catch {
      return []
    }
  }
  return records
}

function tablePayload(data: Record<string, unknown>): {
  readonly payload: TaTablePayload
  readonly truncated: boolean
} {
  for (const key of ['datalist', 'data_list', 'userEventSeqList']) {
    const list = data[key]
    if (Array.isArray(list)) {
      const records = list.filter(isRecord)
      if (records.length > 0) return recordsTable(records)
    }
  }
  if (typeof data.data === 'string') {
    const records = parseNdjson(data.data)
    if (records.length > 0) return recordsTable(records)
  }
  return recordsTable(Object.entries(data).map(([key, value]) => ({ field: key, value })))
}

/** Convert one real TA response into the bounded, durable UI contract. */
export function buildTaPresentation(
  sourceToolInput: string,
  result: unknown,
  requestedView: TaPresentationView | 'auto',
  title?: string,
): TaPresentationModel {
  const sourceTool = rawToolName(sourceToolInput)
  const data = analysisData(result)
  const generatedAt = generatedAtOf(result)
  const preferred = requestedView === 'auto' ? SOURCE_TO_AUTO_VIEW[sourceTool] ?? 'table' : requestedView
  const heading = clipText(title?.trim() || DEFAULT_TITLES[sourceTool] || 'TA 数据分析')
  const provenance = generatedAt === undefined ? {} : { generatedAt }

  if (preferred === 'funnel') {
    const mapped = funnelPayload(data)
    if (mapped !== undefined) return { schemaVersion: 1, view: 'funnel', title: heading, sourceTool, ...provenance, ...mapped }
  }
  if (preferred === 'heatmap') {
    const mapped = heatmapPayload(data)
    if (mapped !== undefined) return { schemaVersion: 1, view: 'heatmap', title: heading, sourceTool, ...provenance, ...mapped }
  }
  if (preferred === 'sankey') {
    const mapped = sankeyPayload(data)
    if (mapped !== undefined) return { schemaVersion: 1, view: 'sankey', title: heading, sourceTool, ...provenance, ...mapped }
  }
  if (preferred === 'line' || preferred === 'bar') {
    const mapped = cartesianPayload(data, sourceTool)
    if (mapped !== undefined) return { schemaVersion: 1, view: preferred, title: heading, sourceTool, ...provenance, ...mapped }
  }
  const mapped = tablePayload(data)
  return { schemaVersion: 1, view: 'table', title: heading, sourceTool, ...provenance, ...mapped }
}

function cacheResult(cache: Map<string, CachedTaResult[]>, sessionId: string, sourceTool: string, result: unknown): void {
  const current = cache.get(sessionId) ?? []
  const generatedAt = generatedAtOf(result)
  const next = [...current, { sourceTool, result, ...(generatedAt === undefined ? {} : { generatedAt }) }].slice(-MAX_CACHE_ENTRIES)
  cache.set(sessionId, next)
}

function sameSource(candidate: string, requested: string): boolean {
  return candidate === rawToolName(requested)
}

function fromCache(
  cache: ReadonlyMap<string, readonly CachedTaResult[]>,
  sessionId: string,
  sourceTool: string,
  generatedAt?: string,
): unknown {
  const entries = cache.get(sessionId) ?? []
  return [...entries].reverse().find(candidate =>
    sameSource(candidate.sourceTool, sourceTool)
    && (generatedAt === undefined || candidate.generatedAt === generatedAt))?.result
}

function fromSessionEvents(session: { readonly events: readonly unknown[] }, sourceTool: string, generatedAt?: string): unknown {
  const calls = new Map<string, string>()
  for (const event of session.events) {
    if (!isRecord(event) || event.type !== 'tool/call' || !isRecord(event.data)) continue
    if (typeof event.data.callId === 'string' && typeof event.data.name === 'string') calls.set(event.data.callId, event.data.name)
  }
  for (const event of [...session.events].reverse()) {
    if (!isRecord(event) || event.type !== 'tool/result' || !isRecord(event.data)) continue
    const message = isRecord(event.data.message) ? event.data.message : undefined
    const source = isRecord(message?.source) ? message.source : undefined
    const callId = typeof source?.callId === 'string' ? source.callId : undefined
    if (callId === undefined || !sameSource(calls.get(callId) ?? '', sourceTool)) continue
    const outer = Array.isArray(message?.content) ? message.content[0] : undefined
    const content = isRecord(outer) ? outer.content : undefined
    const result = textJson(content)
    if (result !== undefined && (generatedAt === undefined || generatedAtOf(result) === generatedAt)) return result
  }
  return undefined
}

function presentationTool(cache: Map<string, CachedTaResult[]>) {
  return defineTool({
    name: 'ta_present',
    description: [
      'Present the most recent successful ThinkingData MCP result as an in-conversation visualization.',
      'Call this only when a chart materially improves comprehension: trends, comparisons, funnels, retention matrices, paths, or distributions.',
      'Do not call it for a single scalar, an error, metadata explanation, or a short result that is clearer in prose.',
      'Set source_tool to the raw TA tool name such as ta_event_analyze; the plugin reads the real prior result, so never copy data into this call.',
    ].join(' '),
    parameters: {
      source_tool: { type: 'string', required: true, description: 'Raw TA MCP tool name that produced the source result.' },
      view: {
        type: 'string', required: true,
        enum: ['auto', 'line', 'bar', 'funnel', 'heatmap', 'sankey', 'table'],
        description: 'Desired presentation. Use auto when the TA model already determines the natural view.',
      },
      title: { type: 'string', description: 'Short business-facing chart title.' },
      generated_at: { type: 'string', description: 'Optional TA result generation time used to disambiguate repeated queries.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemaVersion: { type: 'integer', required: true },
          view: { type: 'string', required: true, enum: ['line', 'bar', 'funnel', 'heatmap', 'sankey', 'table'] },
          title: { type: 'string', required: true },
          sourceTool: { type: 'string', required: true },
          generatedAt: { type: 'string' },
          truncated: { type: 'boolean', required: true },
          payload: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Prepared ${value.view} presentation for ${value.sourceTool}.` }],
      presentationMeta: (_args, value) => value,
    },
    finalizeContent(exec, result) {
      if (exec.parent === undefined || result.isError) return undefined
      return [{
        type: 'text',
        text: `Prepared nested presentation.\n${TA_PRESENTATION_MARKER}${JSON.stringify(result.value)}`,
      }]
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('ta_present requires an owning agent session')
      if (!isTaSourceTool(args.source_tool)) throw new Error('source_tool must be a TA MCP tool name')
      const sessionId = String(exec.agent.session.id)
      const source = fromCache(cache, sessionId, args.source_tool, args.generated_at)
        ?? fromSessionEvents(exec.agent.session, args.source_tool, args.generated_at)
      if (source === undefined) {
        throw new Error(`no matching successful TA result found for ${JSON.stringify(args.source_tool)} in this session`)
      }
      const model = buildTaPresentation(args.source_tool, source, args.view, args.title)
      return { ...model, payload: model.payload as unknown as JsonValue }
    },
  })
}

export function apply(ctx: Context): void {
  const cache = new Map<string, CachedTaResult[]>()
  ctx.on('tools/result', (exec, result: Readonly<ToolExecutionResult>) => {
    if (result.isError || exec.agent === undefined || !isTaSourceTool(exec.name)) return
    const extracted = extractTaResult(result.value, result.content)
    if (extracted === undefined) return
    cacheResult(cache, String(exec.agent.session.id), rawToolName(exec.name), extracted)
  })
  ctx.on('session/disposed', (session) => { cache.delete(String(session.id)) })
  ctx.effect(() => ctx.tools.register(presentationTool(cache)), 'desktop-ta-presentation: tool')
  ctx.get('systemPrompt')?.section({
    name: 'desktop-ta-presentation',
    order: 82,
    text: [
      'After a successful ThinkingData MCP analysis, decide whether a visual materially improves the answer.',
      'Use ta_present for trends, comparisons, funnels, retention matrices, paths, and distributions; otherwise answer in prose.',
      'The visualization is supporting evidence, so still explain the conclusion and analysis scope in the final response.',
    ].join(' '),
  })
}
