import { describe, expect, it } from 'vitest'
import { parseVisionBridgeDocument, serializeVisionBridgeDocument } from '../src/vision-document.ts'

describe('vision bridge document migration', () => {
  it('retains a version-one endpoint as inactive legacy configuration', () => {
    const document = parseVisionBridgeDocument(JSON.stringify({
      version: 1,
      vision: {
        baseURL: 'https://legacy.example/v1',
        apiKey: 'secret-value',
        model: 'legacy-vl',
      },
      targets: [{ provider: 'text-provider', model: 'text-model', enabled: true }],
    }))

    expect(document).toEqual({
      version: 2,
      vision: { provider: '', model: '' },
      legacyVision: {
        baseURL: 'https://legacy.example/v1',
        apiKey: 'secret-value',
        model: 'legacy-vl',
      },
      targets: [{ provider: 'text-provider', model: 'text-model', enabled: true }],
    })
    expect(serializeVisionBridgeDocument(document)).toContain('"secret-value"')
  })

  it('round-trips the Harness provider and model selection', () => {
    const document = parseVisionBridgeDocument(JSON.stringify({
      version: 2,
      vision: { provider: 'vision-provider', model: 'vision-model' },
      targets: [],
    }))

    expect(parseVisionBridgeDocument(serializeVisionBridgeDocument(document))).toEqual(document)
  })
})
