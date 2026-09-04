import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type {
  McpHttpServerView,
  McpServerFiberPhase,
  McpServerOrigin,
  McpServerUpsertRequest,
  McpServerView,
  McpStdioServerView,
} from '../shared/types.ts'

export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
export const RESERVED_MCP_SERVER_NAMES = new Set(['ta-mcp-server', 'starweave-design'])
const REMOVED_MCP_SERVER_NAMES = new Set(['openpencil-mcp'])

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

export interface McpStdioRecord {
  readonly transport: 'stdio'
  readonly serverName: string
  readonly enabled: boolean
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
}

export interface McpHttpRecord {
  readonly transport: 'streamable-http'
  readonly serverName: string
  readonly enabled: boolean
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
}

export type McpServerRecord = McpStdioRecord | McpHttpRecord

export interface McpSystemOverride {
  readonly serverName: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
}

export interface McpSettingsDocument {
  readonly version: 2
  readonly servers: readonly McpServerRecord[]
  readonly systemOverrides: readonly McpSystemOverride[]
}

export function emptyMcpSettingsDocument(): McpSettingsDocument {
  return { version: 2, servers: [], systemOverrides: [] }
}

export function parseMcpSettingsDocument(text: string): McpSettingsDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('mcp-settings: document is not valid JSON', { cause })
  }
  if (!isRecord(parsed)) throw new Error('mcp-settings: document must be a JSON object')
  const version = parsed.version
  assertKnownKeys(parsed, version === 1 ? ['version', 'servers'] : ['version', 'servers', 'systemOverrides'], 'document')
  if (version !== 1 && version !== 2) {
    throw new Error(`mcp-settings: unsupported document version ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.servers)) throw new Error('mcp-settings: document.servers must be an array')
  const servers = parsed.servers
    .map((entry, index) => parseRecord(entry, `servers[${index}]`))
    .filter(server => !isReservedMcpServerName(server.serverName) && !isRemovedMcpServerName(server.serverName))
  const names = new Set<string>()
  for (const server of servers) {
    if (names.has(server.serverName)) {
      throw new Error(`mcp-settings: duplicate serverName ${JSON.stringify(server.serverName)}`)
    }
    names.add(server.serverName)
  }
  const systemOverrides = version === 2
    ? parseSystemOverrides(parsed.systemOverrides)
    : []
  return { version: 2, servers, systemOverrides }
}

export function serializeMcpSettingsDocument(document: McpSettingsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export function upsertMcpServerRecord(
  document: McpSettingsDocument,
  request: McpServerUpsertRequest,
): McpSettingsDocument {
  const nextName = parseServerName(request.serverName)
  if (isRemovedMcpServerName(nextName)) {
    throw new Error(`mcp-settings: serverName ${JSON.stringify(nextName)} belongs to a removed integration`)
  }
  const fromName = request.fromServerName === undefined
    ? nextName
    : parseServerName(request.fromServerName, 'fromServerName')
  const existing = document.servers.find(server => server.serverName === fromName)
  if (fromName !== nextName) {
    if (existing === undefined) {
      throw new Error(`mcp-settings: no Settings-owned server named ${JSON.stringify(fromName)}`)
    }
    if (document.servers.some(server => server.serverName === nextName)) {
      throw new Error(`mcp-settings: serverName ${JSON.stringify(nextName)} is already in use`)
    }
  }
  const next = mergeRecord(existing, request)
  return {
    ...document,
    servers: existing === undefined
      ? [...document.servers, next]
      : document.servers.map(server => server.serverName === fromName ? next : server),
  }
}

export function removeMcpServerRecord(
  document: McpSettingsDocument,
  serverName: string,
): McpSettingsDocument {
  return { ...document, servers: document.servers.filter(server => server.serverName !== serverName) }
}

export function updateMcpSystemOverride(
  document: McpSettingsDocument,
  override: McpSystemOverride,
): McpSettingsDocument {
  const serverName = parseServerName(override.serverName)
  const previous = document.systemOverrides.find(entry => entry.serverName === serverName)
  const url = override.url === undefined ? previous?.url : requiredString(override.url, 'url')
  const headers = override.headers === undefined ? previous?.headers : parseStringMap(override.headers, 'headers')
  const next = {
    serverName,
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
    toolCallTimeoutMs: parsePositive(override.toolCallTimeoutMs, 'toolCallTimeoutMs'),
    failOnStartupError: parseBoolean(override.failOnStartupError, 'failOnStartupError'),
  }
  const exists = document.systemOverrides.some(entry => entry.serverName === serverName)
  return {
    ...document,
    systemOverrides: exists
      ? document.systemOverrides.map(entry => entry.serverName === serverName ? next : entry)
      : [...document.systemOverrides, next],
  }
}

export function applyMcpSystemOverride(
  record: McpServerRecord,
  document: McpSettingsDocument,
): McpServerRecord {
  const override = document.systemOverrides.find(entry => entry.serverName === record.serverName)
  return override === undefined ? record : {
    ...record,
    enabled: true,
    ...(record.transport === 'streamable-http' && override.url !== undefined ? { url: override.url } : {}),
    ...(record.transport === 'streamable-http' && override.headers !== undefined ? { headers: override.headers } : {}),
    toolCallTimeoutMs: override.toolCallTimeoutMs,
    failOnStartupError: override.failOnStartupError,
  }
}

export function toMcpClientConfig(record: McpServerRecord): McpClientConfig {
  if (record.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName: record.serverName,
      command: record.command,
      args: [...record.args],
      env: { ...record.env },
      cwd: record.cwd,
      toolCallTimeoutMs: record.toolCallTimeoutMs,
      failOnStartupError: record.failOnStartupError,
    }
  }
  return {
    transport: 'streamable-http',
    serverName: record.serverName,
    url: record.url,
    headers: { ...record.headers },
    toolCallTimeoutMs: record.toolCallTimeoutMs,
    failOnStartupError: record.failOnStartupError,
  }
}

export function countMcpTools(names: readonly string[], serverName: string): number {
  const prefix = `mcp__${serverName}__`
  return names.filter(name => name.startsWith(prefix)).length
}

export function viewMcpServerRecord(
  record: McpServerRecord,
  origin: McpServerOrigin,
  fiberPhase: McpServerFiberPhase,
  toolCount: number,
): McpServerView {
  const common = {
    serverName: record.serverName,
    origin,
    enabled: record.enabled,
    fiberPhase,
    toolCount,
    toolCallTimeoutMs: record.toolCallTimeoutMs,
    failOnStartupError: record.failOnStartupError,
  }
  if (record.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: record.command,
      args: [...record.args],
      cwd: record.cwd,
      envKeys: Object.keys(record.env),
      headerKeys: [],
    } satisfies McpStdioServerView
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: record.url,
    envKeys: [],
    headerKeys: Object.keys(record.headers),
  } satisfies McpHttpServerView
}

export function isReservedMcpServerName(serverName: string): boolean {
  return RESERVED_MCP_SERVER_NAMES.has(serverName)
}

function isRemovedMcpServerName(serverName: string): boolean {
  return REMOVED_MCP_SERVER_NAMES.has(serverName)
}

export function viewCompositionConfig(
  config: unknown,
  enabled: boolean,
  fiberPhase: McpServerFiberPhase,
  toolNames: readonly string[],
): McpServerView | null {
  if (!isRecord(config) || typeof config.serverName !== 'string') return null
  if (!SERVER_NAME_PATTERN.test(config.serverName)) return null
  const toolCount = countMcpTools(toolNames, config.serverName)
  if (config.transport === 'stdio' && typeof config.command === 'string') {
    return viewMcpServerRecord({
      transport: 'stdio',
      serverName: config.serverName,
      enabled,
      command: config.command,
      args: Array.isArray(config.args) ? config.args.filter((item): item is string => typeof item === 'string') : [],
      env: stringMap(config.env),
      cwd: typeof config.cwd === 'string' ? config.cwd : '',
      toolCallTimeoutMs: numberOr(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
      failOnStartupError: config.failOnStartupError === true,
    }, 'composition', fiberPhase, toolCount)
  }
  if (config.transport === 'streamable-http' && typeof config.url === 'string') {
    return viewMcpServerRecord({
      transport: 'streamable-http',
      serverName: config.serverName,
      enabled,
      url: config.url,
      headers: stringMap(config.headers),
      toolCallTimeoutMs: numberOr(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
      failOnStartupError: config.failOnStartupError === true,
    }, 'composition', fiberPhase, toolCount)
  }
  return null
}

function mergeRecord(existing: McpServerRecord | undefined, request: McpServerUpsertRequest): McpServerRecord {
  const enabled = request.enabled ?? existing?.enabled ?? true
  const toolCallTimeoutMs = request.toolCallTimeoutMs ?? existing?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  const failOnStartupError = request.failOnStartupError ?? existing?.failOnStartupError ?? false
  if (request.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName: parseServerName(request.serverName),
      enabled,
      command: requiredString(request.command, 'command'),
      args: request.args === undefined ? [] : parseStringArray(request.args, 'args'),
      env: request.env ?? (existing?.transport === 'stdio' ? existing.env : {}),
      cwd: request.cwd ?? '',
      toolCallTimeoutMs,
      failOnStartupError,
    }
  }
  return {
    transport: 'streamable-http',
    serverName: parseServerName(request.serverName),
    enabled,
    url: requiredString(request.url, 'url'),
    headers: request.headers ?? (existing?.transport === 'streamable-http' ? existing.headers : {}),
    toolCallTimeoutMs,
    failOnStartupError,
  }
}

function parseRecord(value: unknown, label: string): McpServerRecord {
  if (!isRecord(value)) throw new Error(`mcp-settings: ${label} must be an object`)
  const serverName = parseServerName(value.serverName, `${label}.serverName`)
  const enabled = value.enabled === undefined ? true : parseBoolean(value.enabled, `${label}.enabled`)
  const toolCallTimeoutMs = value.toolCallTimeoutMs === undefined
    ? DEFAULT_TOOL_CALL_TIMEOUT_MS
    : parsePositive(value.toolCallTimeoutMs, `${label}.toolCallTimeoutMs`)
  const failOnStartupError = value.failOnStartupError === undefined
    ? false
    : parseBoolean(value.failOnStartupError, `${label}.failOnStartupError`)
  if (value.transport === 'stdio') {
    assertKnownKeys(value, [
      'transport', 'serverName', 'enabled', 'command', 'args', 'env', 'cwd',
      'toolCallTimeoutMs', 'failOnStartupError',
    ], label)
    return {
      transport: 'stdio', serverName, enabled,
      command: requiredString(value.command, `${label}.command`),
      args: parseStringArray(value.args, `${label}.args`),
      env: parseStringMap(value.env, `${label}.env`),
      cwd: parseOptionalString(value.cwd, `${label}.cwd`),
      toolCallTimeoutMs, failOnStartupError,
    }
  }
  if (value.transport === 'streamable-http') {
    assertKnownKeys(value, [
      'transport', 'serverName', 'enabled', 'url', 'headers',
      'toolCallTimeoutMs', 'failOnStartupError',
    ], label)
    return {
      transport: 'streamable-http', serverName, enabled,
      url: requiredString(value.url, `${label}.url`),
      headers: parseStringMap(value.headers, `${label}.headers`),
      toolCallTimeoutMs, failOnStartupError,
    }
  }
  throw new Error(`mcp-settings: ${label}.transport must be "stdio" or "streamable-http"`)
}

function parseSystemOverrides(value: unknown): McpSystemOverride[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('mcp-settings: document.systemOverrides must be an array')
  const result = value.map((entry, index) => {
    const label = `systemOverrides[${String(index)}]`
    if (!isRecord(entry)) throw new Error(`mcp-settings: ${label} must be an object`)
    assertKnownKeys(entry, ['serverName', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError'], label)
    return {
      serverName: parseServerName(entry.serverName, `${label}.serverName`),
      ...(entry.url === undefined ? {} : { url: requiredString(entry.url, `${label}.url`) }),
      ...(entry.headers === undefined ? {} : { headers: parseStringMap(entry.headers, `${label}.headers`) }),
      toolCallTimeoutMs: parsePositive(entry.toolCallTimeoutMs, `${label}.toolCallTimeoutMs`),
      failOnStartupError: parseBoolean(entry.failOnStartupError, `${label}.failOnStartupError`),
    }
  })
  const retained = result.filter(entry => !isRemovedMcpServerName(entry.serverName))
  if (new Set(retained.map(entry => entry.serverName)).size !== retained.length) {
    throw new Error('mcp-settings: duplicate system override serverName')
  }
  return retained
}

function parseServerName(value: unknown, label = 'serverName'): string {
  const name = requiredString(value, label)
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`mcp-settings: ${label} must match [A-Za-z0-9_-]{1,32}`)
  }
  return name
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`mcp-settings: ${label} must be a non-empty string`)
  }
  return value
}

function parseOptionalString(value: unknown, label: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`mcp-settings: ${label} must be a string`)
  return value
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`mcp-settings: ${label} must be a boolean`)
  return value
}

function parsePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error(`mcp-settings: ${label} must be a positive number`)
  }
  return value
}

function parseStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`mcp-settings: ${label} must be an array of strings`)
  }
  return value as string[]
}

function parseStringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`mcp-settings: ${label} must be an object of strings`)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`mcp-settings: ${label}.${key} must be a string`)
    result[key] = entry
  }
  return result
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : fallback
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`mcp-settings: ${label} has unknown key ${JSON.stringify(key)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
