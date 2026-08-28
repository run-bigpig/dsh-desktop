export interface VisionModelSelectionRecord {
  readonly provider: string
  readonly model: string
}

export interface LegacyVisionEndpointRecord {
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
}

export interface VisionTargetRecord {
  readonly provider: string
  readonly model: string
  readonly enabled: boolean
}

export interface VisionBridgeDocument {
  readonly version: 2
  readonly vision: VisionModelSelectionRecord
  readonly legacyVision?: LegacyVisionEndpointRecord
  readonly targets: readonly VisionTargetRecord[]
}

export function emptyVisionBridgeDocument(): VisionBridgeDocument {
  return { version: 2, vision: { provider: '', model: '' }, targets: [] }
}

export function parseVisionBridgeDocument(text: string): VisionBridgeDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('vision-bridge: document is not valid JSON', { cause })
  }
  if (!isRecord(parsed)) throw new Error('vision-bridge: document must be a JSON object')
  if (parsed.version === 1) return migrateVersionOne(parsed)
  assertKnownKeys(parsed, ['version', 'vision', 'legacyVision', 'targets'], 'document')
  if (parsed.version !== 2) {
    throw new Error(`vision-bridge: unsupported document version ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.targets)) throw new Error('vision-bridge: document.targets must be an array')
  const vision = parsed.vision === undefined ? emptyVisionBridgeDocument().vision : parseSelection(parsed.vision)
  const legacyVision = parsed.legacyVision === undefined ? undefined : parseLegacyVision(parsed.legacyVision)
  const targets = parsed.targets.map((entry, index) => parseTarget(entry, index))
  return {
    version: 2,
    vision,
    ...legacyVision === undefined ? {} : { legacyVision },
    targets: dedupeTargets(targets),
  }
}

export function serializeVisionBridgeDocument(document: VisionBridgeDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export function visionModelReady(vision: VisionModelSelectionRecord): boolean {
  return vision.provider.length > 0 && vision.model.length > 0
}

export function isTargetEnabled(
  targets: readonly VisionTargetRecord[],
  provider: string,
  model: string,
): boolean {
  return targets.some(target => target.provider === provider && target.model === model && target.enabled)
}

export function mergeVision(
  next: { readonly provider: string; readonly model: string },
): VisionModelSelectionRecord {
  return {
    provider: next.provider.trim(),
    model: next.model.trim(),
  }
}

function parseSelection(value: unknown): VisionModelSelectionRecord {
  if (!isRecord(value)) throw new Error('vision-bridge: document.vision must be an object')
  assertKnownKeys(value, ['provider', 'model'], 'vision')
  return {
    provider: parseString(value.provider, 'vision.provider').trim(),
    model: parseString(value.model, 'vision.model').trim(),
  }
}

function parseLegacyVision(value: unknown): LegacyVisionEndpointRecord {
  if (!isRecord(value)) throw new Error('vision-bridge: document.legacyVision must be an object')
  assertKnownKeys(value, ['baseURL', 'apiKey', 'model'], 'legacyVision')
  return {
    baseURL: parseString(value.baseURL, 'legacyVision.baseURL').trim(),
    apiKey: parseString(value.apiKey, 'legacyVision.apiKey'),
    model: parseString(value.model, 'legacyVision.model').trim(),
  }
}

function migrateVersionOne(parsed: Record<string, unknown>): VisionBridgeDocument {
  assertKnownKeys(parsed, ['version', 'vision', 'targets'], 'document')
  if (!Array.isArray(parsed.targets)) throw new Error('vision-bridge: document.targets must be an array')
  const legacyVision = parsed.vision === undefined
    ? { baseURL: '', apiKey: '', model: '' }
    : parseLegacyVision(parsed.vision)
  const targets = parsed.targets.map((entry, index) => parseTarget(entry, index))
  return {
    version: 2,
    vision: { provider: '', model: '' },
    ...legacyVision.baseURL.length === 0 && legacyVision.apiKey.length === 0 && legacyVision.model.length === 0
      ? {}
      : { legacyVision },
    targets: dedupeTargets(targets),
  }
}

function parseTarget(value: unknown, index: number): VisionTargetRecord {
  const label = `targets[${String(index)}]`
  if (!isRecord(value)) throw new Error(`vision-bridge: ${label} must be an object`)
  assertKnownKeys(value, ['provider', 'model', 'enabled'], label)
  if (typeof value.enabled !== 'boolean') throw new Error(`vision-bridge: ${label}.enabled must be a boolean`)
  const provider = parseString(value.provider, `${label}.provider`).trim()
  const model = parseString(value.model, `${label}.model`).trim()
  if (provider.length === 0 || model.length === 0) throw new Error(`vision-bridge: ${label} route must be non-empty`)
  return { provider, model, enabled: value.enabled }
}

function dedupeTargets(targets: readonly VisionTargetRecord[]): VisionTargetRecord[] {
  const seen = new Map<string, VisionTargetRecord>()
  for (const target of targets) seen.set(`${target.provider}\0${target.model}`, target)
  return [...seen.values()]
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`vision-bridge: ${label} must be a string`)
  return value
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`vision-bridge: unexpected ${label} key ${JSON.stringify(key)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
