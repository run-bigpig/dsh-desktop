export interface OpenPencilDocument {
  readonly version: 1
  readonly enabled: boolean
}

export function emptyOpenPencilDocument(): OpenPencilDocument {
  return { version: 1, enabled: false }
}

export function parseOpenPencilDocument(text: string): OpenPencilDocument {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('openpencil: settings document is not valid JSON', { cause })
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== 'boolean') {
    throw new Error('openpencil: settings document has an invalid shape')
  }
  if (Object.keys(value).some(key => !['version', 'enabled'].includes(key))) {
    throw new Error('openpencil: settings document contains unknown fields')
  }
  return { version: 1, enabled: value.enabled }
}

export function serializeOpenPencilDocument(document: OpenPencilDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
