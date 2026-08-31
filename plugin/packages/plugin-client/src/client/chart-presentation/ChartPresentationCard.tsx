import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bar, Funnel, Heatmap, Line, Sankey } from '@ant-design/plots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChartCartesianPayload,
  ChartFunnelPayload,
  ChartHeatmapPayload,
  ChartPresentationModel,
  ChartSankeyPayload,
  ChartTablePayload,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import css from './ChartPresentationCard.module.css'

const CHART_PRESENTATION_MARKER = '[DSH_CHART_PRESENTATION_V1]'
const MAX_LABELS = 500
const MAX_SERIES = 8
const MAX_TABLE_COLUMNS = 16
const MAX_TABLE_ROWS = 200
const MAX_HEATMAP_ROWS = 60
const MAX_HEATMAP_COLUMNS = 60
const MAX_SANKEY_LINKS = 200
const MAX_TEXT_LENGTH = 160
const MAX_CELL_LENGTH = 500

export type ChartPresentationCardProps = ToolCallViewProps & PropsLocale<'desktop.chartPresentation'>

interface ChartTheme {
  readonly textPrimary: string
  readonly textSecondary: string
  readonly onAccent: string
  readonly grid: string
  readonly series: string[]
  readonly heatmap: string[]
}

function fallbackTheme(dark: boolean): ChartTheme {
  return dark ? {
    textPrimary: '#f1f3f5',
    textSecondary: '#adb2b8',
    onAccent: '#0f1115',
    grid: 'rgba(255, 255, 255, 0.12)',
    series: ['#679efe', '#4ed17e', '#f2b84b', '#f25a5a', '#93c5fd', '#b7c8fe', '#d7a8ff', '#70c7d4'],
    heatmap: ['#2c2c2e', '#34415b', '#679efe'],
  } : {
    textPrimary: '#0f1115',
    textSecondary: '#61666b',
    onAccent: '#ffffff',
    grid: 'rgba(0, 0, 0, 0.10)',
    series: ['#4176e6', '#22c55e', '#d99520', '#ec1313', '#3b82f6', '#5268b2', '#8b5cf6', '#1596a8'],
    heatmap: ['#f1f3f5', '#d3e2ff', '#4176e6'],
  }
}

function readChartTheme(): ChartTheme {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallbackTheme(false)
  const dark = document.body.hasAttribute('data-ds-dark-theme')
  const fallback = fallbackTheme(dark)
  const styles = getComputedStyle(document.body)
  const token = (name: string, value: string): string => styles.getPropertyValue(name).trim() || value
  return {
    textPrimary: token('--dsw-alias-label-primary', fallback.textPrimary),
    textSecondary: token('--dsw-alias-label-secondary', fallback.textSecondary),
    onAccent: token('--dsw-alias-label-primary-foreground', fallback.onAccent),
    grid: token('--dsw-alias-border-l2', fallback.grid),
    series: [
      token('--dsw-alias-state-business-primary', fallback.series[0] ?? '#4176e6'),
      token('--dsw-alias-state-success-primary', fallback.series[1] ?? '#22c55e'),
      token('--dsw-alias-state-warn-primary', fallback.series[2] ?? '#d99520'),
      token('--dsw-alias-state-error-primary', fallback.series[3] ?? '#ec1313'),
      token('--dsw-static-blue-400', fallback.series[4] ?? '#3b82f6'),
      token('--dsw-static-deepseek-600', fallback.series[5] ?? '#5268b2'),
      token('--dsw-static-purple-400', fallback.series[6] ?? '#8b5cf6'),
      token('--dsw-static-cyan-500', fallback.series[7] ?? '#1596a8'),
    ],
    heatmap: [
      token('--dsw-alias-bg-layer-2', fallback.heatmap[0] ?? '#f1f3f5'),
      token('--dsw-alias-state-business-tertiary', fallback.heatmap[1] ?? '#d3e2ff'),
      token('--dsw-alias-state-business-primary', fallback.heatmap[2] ?? '#4176e6'),
    ],
  }
}

function sameTheme(left: ChartTheme, right: ChartTheme): boolean {
  return left.textPrimary === right.textPrimary
    && left.textSecondary === right.textSecondary
    && left.onAccent === right.onAccent
    && left.grid === right.grid
    && left.series.every((value, index) => value === right.series[index])
    && left.heatmap.every((value, index) => value === right.heatmap[index])
}

function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState(readChartTheme)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return undefined
    const update = (): void => {
      const next = readChartTheme()
      setTheme(current => sameTheme(current, next) ? current : next)
    }
    const observer = new MutationObserver(update)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
    return () => { observer.disconnect() }
  }, [])
  return theme
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.length <= MAX_TEXT_LENGTH)
}

function isNumericArray(value: unknown): value is (number | null)[] {
  return Array.isArray(value) && value.every(entry => entry === null || (typeof entry === 'number' && Number.isFinite(entry)))
}

function isTableCell(value: unknown): value is string | number | boolean | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_CELL_LENGTH) || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

function isPresentation(value: unknown): value is ChartPresentationModel {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !['line', 'bar', 'funnel', 'heatmap', 'sankey', 'table'].includes(String(value.view))
    || typeof value.title !== 'string' || value.title.length > MAX_TEXT_LENGTH
    || typeof value.truncated !== 'boolean'
    || !isRecord(value.payload)) return false
  if (value.source !== undefined
    && (typeof value.source !== 'string' || value.source.length === 0 || value.source.length > MAX_TEXT_LENGTH)) return false
  if (value.generatedAt !== undefined
    && (typeof value.generatedAt !== 'string' || value.generatedAt.length > MAX_TEXT_LENGTH)) return false
  const payload = value.payload
  switch (value.view) {
    case 'line':
    case 'bar': {
      const labels = payload.labels
      const seriesList = payload.series
      return isStringArray(labels) && labels.length <= MAX_LABELS
        && Array.isArray(seriesList)
        && seriesList.length <= MAX_SERIES
        && seriesList.every(series => isRecord(series)
          && typeof series.name === 'string' && series.name.length <= MAX_TEXT_LENGTH
          && isNumericArray(series.values)
          && series.values.length === labels.length
          && (series.format === undefined || series.format === 'number' || series.format === 'percent'))
    }
    case 'funnel': {
      const steps = payload.steps
      return Array.isArray(steps)
        && steps.length <= 20
        && steps.every(step => isRecord(step) && typeof step.label === 'string' && step.label.length <= MAX_TEXT_LENGTH
          && typeof step.value === 'number' && Number.isFinite(step.value))
    }
    case 'heatmap': {
      const columns = payload.columns
      const rows = payload.rows
      return isStringArray(columns) && columns.length <= MAX_HEATMAP_COLUMNS
        && (payload.format === 'number' || payload.format === 'percent')
        && Array.isArray(rows)
        && rows.length <= MAX_HEATMAP_ROWS
        && rows.every(row => isRecord(row)
          && typeof row.label === 'string' && row.label.length <= MAX_TEXT_LENGTH
          && (row.initial === undefined || (typeof row.initial === 'number' && Number.isFinite(row.initial)))
          && isNumericArray(row.values)
          && row.values.length <= columns.length)
    }
    case 'sankey': {
      const links = payload.links
      return Array.isArray(links)
        && links.length <= MAX_SANKEY_LINKS
        && links.every(link => isRecord(link)
          && typeof link.source === 'string' && link.source.length <= MAX_TEXT_LENGTH
          && typeof link.target === 'string' && link.target.length <= MAX_TEXT_LENGTH
          && typeof link.value === 'number' && Number.isFinite(link.value) && link.value >= 0)
    }
    case 'table': {
      const columns = payload.columns
      const rows = payload.rows
      return isStringArray(columns) && columns.length <= MAX_TABLE_COLUMNS
        && Array.isArray(rows)
        && rows.length <= MAX_TABLE_ROWS
        && rows.every(row => Array.isArray(row)
          && row.length <= columns.length
          && row.every(isTableCell))
    }
    default:
      return false
  }
}

function textContent(content: readonly unknown[]): string {
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return []
    return [block.text]
  }).join('\n')
}

export function presentationFromBlock(
  block: ChartPresentationCardProps['block'],
): ChartPresentationModel | undefined {
  if (!('kind' in block)) return undefined
  if (isPresentation(block.meta)) return block.meta
  const markerText = textContent(block.content)
  const index = markerText.indexOf(CHART_PRESENTATION_MARKER)
  if (index >= 0) {
    try {
      const parsed = JSON.parse(markerText.slice(index + CHART_PRESENTATION_MARKER.length)) as unknown
      return isPresentation(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function formatValue(value: number | null | undefined, format: 'number' | 'percent' = 'number'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (format === 'percent') return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}%`
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}

function AnalyticsMark(): ReactNode {
  return (
    <svg aria-hidden="true" className={css.mark} viewBox="0 0 24 24">
      <path d="M4 18V9m5 9V5m5 13v-7m5 7V3" />
      <path d="M3 21h18" />
    </svg>
  )
}

function cartesianData(payload: ChartCartesianPayload) {
  return payload.labels.flatMap((label, labelIndex) => payload.series.flatMap(series => {
    const value = series.values[labelIndex]
    return value === null || value === undefined ? [] : [{ label, series: series.name, value }]
  }))
}

function heatmapData(payload: ChartHeatmapPayload) {
  return payload.rows.flatMap(row => payload.columns.flatMap((column, columnIndex) => {
    const value = row.values[columnIndex]
    return value === null || value === undefined ? [] : [{ cohort: row.label, column, value }]
  }))
}

function EmptyChart({ label }: { readonly label: string }): ReactNode {
  return <div className={css.chartEmpty} role="img" aria-label={label}>—</div>
}

function AntvFrame({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return <div className={css.antvChart} role="img" aria-label={label}>{children}</div>
}

function LineChart({ payload, label, theme }: {
  readonly payload: ChartCartesianPayload
  readonly label: string
  readonly theme: ChartTheme
}): ReactNode {
  const data = cartesianData(payload)
  if (data.length === 0) return <EmptyChart label={label} />
  return (
    <AntvFrame label={label}>
      <Line
        animation={false}
        axis={{
          x: { labelAutoHide: true, labelAutoRotate: true, labelFill: theme.textSecondary, lineStroke: theme.grid, title: false },
          y: { gridStroke: theme.grid, labelFill: theme.textSecondary, title: false },
        }}
        colorField="series"
        data={data}
        legend={{ color: { labelFill: theme.textSecondary, position: 'bottom' } }}
        point={data.length <= 64 ? { sizeField: 3 } : false}
        scale={{ color: { range: theme.series } }}
        style={{ lineWidth: 2 }}
        xField="label"
        yField="value"
      />
    </AntvFrame>
  )
}

function BarChart({ payload, label, theme }: {
  readonly payload: ChartCartesianPayload
  readonly label: string
  readonly theme: ChartTheme
}): ReactNode {
  const data = cartesianData(payload)
  if (data.length === 0) return <EmptyChart label={label} />
  return (
    <AntvFrame label={label}>
      <Bar
        animation={false}
        axis={{
          x: { gridStroke: theme.grid, labelFill: theme.textSecondary, title: false },
          y: { labelAutoHide: true, labelFill: theme.textSecondary, lineStroke: theme.grid, title: false },
        }}
        colorField="series"
        data={data}
        group={payload.series.length > 1}
        legend={{ color: { labelFill: theme.textSecondary, position: 'bottom' } }}
        scale={{ color: { range: theme.series }, x: { padding: 0.35 } }}
        xField="label"
        yField="value"
      />
    </AntvFrame>
  )
}

function FunnelChart({ payload, label, theme }: {
  readonly payload: ChartFunnelPayload
  readonly label: string
  readonly theme: ChartTheme
}): ReactNode {
  if (payload.steps.length === 0) return <EmptyChart label={label} />
  return (
    <AntvFrame label={label}>
      <Funnel
        animation={false}
        colorField="label"
        data={payload.steps}
        label={{
          text: (datum: ChartFunnelPayload['steps'][number]) => `${datum.label}\n${formatValue(datum.value)}`,
          style: { fill: theme.onAccent, fontWeight: 600 },
        }}
        scale={{ color: { range: theme.series } }}
        xField="label"
        yField="value"
      />
    </AntvFrame>
  )
}

function HeatmapChart({ payload, label, theme }: {
  readonly payload: ChartHeatmapPayload
  readonly label: string
  readonly theme: ChartTheme
}): ReactNode {
  const data = heatmapData(payload)
  if (data.length === 0) return <EmptyChart label={label} />
  return (
    <AntvFrame label={label}>
      <Heatmap
        animation={false}
        axis={{
          x: { labelAutoHide: true, labelFill: theme.textSecondary, lineStroke: theme.grid, title: false },
          y: { labelAutoHide: true, labelFill: theme.textSecondary, lineStroke: theme.grid, title: false },
        }}
        colorField="value"
        data={data}
        label={{ text: (datum: { readonly value: number }) => formatValue(datum.value, payload.format), style: { fill: theme.textPrimary, fontSize: 10 } }}
        scale={{ color: { range: theme.heatmap } }}
        xField="column"
        yField="cohort"
      />
    </AntvFrame>
  )
}

function SankeyChart({ payload, label, theme }: {
  readonly payload: ChartSankeyPayload
  readonly label: string
  readonly theme: ChartTheme
}): ReactNode {
  if (payload.links.length === 0) return <EmptyChart label={label} />
  return (
    <AntvFrame label={label}>
      <Sankey
        animation={false}
        data={payload.links}
        layout={{ nodeWidth: 0.012 }}
        scale={{ color: { range: theme.series } }}
        style={{ labelFill: theme.textPrimary, labelFontSize: 11, linkFillOpacity: 0.35, nodeLineWidth: 0 }}
      />
    </AntvFrame>
  )
}

function DataTable({ payload, label }: { readonly payload: ChartTablePayload; readonly label: string }): ReactNode {
  return (
    <div className={css.tableWrap} role="region" aria-label={label} tabIndex={0}>
      <table className={css.table}>
        <thead><tr>{payload.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>
          {payload.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{payload.columns.map((_column, columnIndex) => (
              <td key={columnIndex}>{row[columnIndex] === null || row[columnIndex] === undefined ? '—' : String(row[columnIndex])}</td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PresentationChart({ model, label }: {
  readonly model: ChartPresentationModel
  readonly label: string
}): ReactNode {
  const theme = useChartTheme()
  switch (model.view) {
    case 'line': return <LineChart payload={model.payload as ChartCartesianPayload} label={label} theme={theme} />
    case 'bar': return <BarChart payload={model.payload as ChartCartesianPayload} label={label} theme={theme} />
    case 'funnel': return <FunnelChart payload={model.payload as ChartFunnelPayload} label={label} theme={theme} />
    case 'heatmap': return <HeatmapChart payload={model.payload as ChartHeatmapPayload} label={label} theme={theme} />
    case 'sankey': return <SankeyChart payload={model.payload as ChartSankeyPayload} label={label} theme={theme} />
    case 'table': return <DataTable payload={model.payload as ChartTablePayload} label={label} />
  }
}

function rawError(block: Extract<ChartPresentationCardProps['block'], { kind: 'tool-result' }>): string {
  const text = textContent(block.content).trim()
  return text.length > 0 ? text : block.error?.code ?? 'Unknown presentation error'
}

export function ChartPresentationCard({ block, inspect, t }: ChartPresentationCardProps): ReactNode {
  const [expanded, setExpanded] = useState(true)
  const model = useMemo(() => presentationFromBlock(block), [block])
  const settled = 'kind' in block
  const failed = settled && block.isError
  const label = model?.title ?? t('title')

  return (
    <section
      className={css.card}
      data-expanded={expanded ? '' : undefined}
      data-phase={!settled ? 'running' : failed ? 'error' : model === undefined ? 'invalid' : 'ready'}
    >
      <header className={css.header}>
        <button className={css.headingButton} type="button" aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
          <span className={css.iconShell}><AnalyticsMark /></span>
          <span className={css.headingCopy}>
            <strong>{label}</strong>
            <span>{!settled ? t('preparing') : failed ? t('failed') : model === undefined ? t('invalid') : model.source ?? t('agentPrepared')}</span>
          </span>
          <span className={css.stateDot} aria-hidden="true" />
          <svg aria-hidden="true" className={css.chevron} data-open={expanded || undefined} viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
        </button>
        {inspect !== undefined && (
          <button className={css.inspect} type="button" onClick={inspect}>{t('inspect')}</button>
        )}
      </header>

      {expanded && (
        <div className={css.body}>
          {!settled && (
            <div className={css.loading} aria-live="polite">
              <span /><span /><span />
              <p>{t('preparingHint')}</p>
            </div>
          )}
          {failed && <div className={css.error} role="alert"><strong>{t('failed')}</strong><p>{rawError(block)}</p></div>}
          {settled && !failed && model === undefined && (
            <div className={css.error} role="alert"><strong>{t('invalid')}</strong><p>{t('invalidHint')}</p></div>
          )}
          {model !== undefined && !failed && (
            <>
              {(model.generatedAt !== undefined || model.truncated) && (
                <div className={css.provenance}>
                  {model.generatedAt !== undefined && <span>{model.generatedAt}</span>}
                  {model.truncated && <span className={css.truncated}>{t('truncated')}</span>}
                </div>
              )}
              <PresentationChart
                model={model}
                label={t(model.view === 'table' ? 'dataLabel' : 'chartLabel', { title: model.title })}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
