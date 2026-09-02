export const DEFAULT_THINKINGDATA_URL = 'http://10.225.40.100:13360/mcp'
export const THINKINGDATA_SERVER_NAME = 'ta-mcp-server'
export const THINKINGDATA_CREDENTIAL_REF = 'STARWEAVE_THINKINGDATA_TOKEN'
export const THINKINGDATA_TOOL_TIMEOUT_MS = 120_000

export interface ThinkingDataDocument {
  readonly version: 1
  readonly enabled: boolean
  readonly url: string
}

export function emptyThinkingDataDocument(): ThinkingDataDocument {
  return { version: 1, enabled: true, url: '' }
}

export function parseThinkingDataDocument(text: string): ThinkingDataDocument {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('thinkingdata: settings document is not valid JSON', { cause })
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.url !== 'string') {
    throw new Error('thinkingdata: settings document has an invalid shape')
  }
  const keys = Object.keys(value)
  if (keys.some(key => !['version', 'enabled', 'url'].includes(key))) {
    throw new Error('thinkingdata: settings document contains unknown fields')
  }
  validateThinkingDataUrl(value.url)
  return { version: 1, enabled: true, url: value.url.trim() }
}

export function serializeThinkingDataDocument(document: ThinkingDataDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export function effectiveThinkingDataUrl(url: string): string {
  return url.trim() || DEFAULT_THINKINGDATA_URL
}

export function validateThinkingDataUrl(url: string): void {
  const candidate = effectiveThinkingDataUrl(url)
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch (cause) {
    throw new Error('thinkingdata: service URL is invalid', { cause })
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
    throw new Error('thinkingdata: service URL must be HTTP or HTTPS without embedded credentials')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
