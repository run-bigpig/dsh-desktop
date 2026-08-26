import { describe, expect, it, vi } from 'vitest'
import {
  GeminiImageAdapter,
  ImageModelAdapterRegistry,
  normalizeImageRequestForAdapter,
  OpenAIImageAdapter,
  type ImageModelDescriptor,
} from '../src/image-adapters.ts'

describe('image model adapters', () => {
  it('calls the OpenAI Images generation endpoint and decodes its image', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from('openai-image').toString('base64') }],
    }), { status: 200 }))
    const adapter = new OpenAIImageAdapter(request as typeof fetch)

    const image = await adapter.generate(openAI('gpt-image-2'), {
      prompt: 'A small red kite',
      size: '1024x1024',
      quality: 'high',
    }, new AbortController().signal)

    expect(Buffer.from(image.data).toString()).toBe('openai-image')
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0] as [URL, RequestInit]
    expect(String(url)).toBe('https://api.openai.example/v1/images/generations')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'A small red kite',
      size: '1024x1024',
      quality: 'high',
    })
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer openai-secret')
  })

  it('calls Gemini Interactions with text and image parts for editing', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [
          { type: 'text', text: 'Here is the edited image.' },
          { type: 'image', data: Buffer.from('gemini-image').toString('base64'), mime_type: 'image/png' },
        ],
      }],
    }), { status: 200 }))
    const adapter = new GeminiImageAdapter(request as typeof fetch)

    const image = await adapter.edit(gemini('gemini-3.1-flash-image'), {
      prompt: 'Move the subject left',
      aspectRatio: '16:9',
      resolution: '2K',
      source: { data: Buffer.from('source'), mediaType: 'image/png', name: 'source.png' },
    }, new AbortController().signal)

    expect(Buffer.from(image.data).toString()).toBe('gemini-image')
    const [url, init] = request.mock.calls[0] as [URL, RequestInit]
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('gemini-secret')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gemini-3.1-flash-image',
      input: [
        { type: 'text', text: 'Move the subject left' },
        { type: 'image', mime_type: 'image/png' },
      ],
      response_format: { type: 'image', aspect_ratio: '16:9', image_size: '2K' },
    })
  })

  it('supports legacy Gemini output arrays and SDK convenience fields', async () => {
    const legacyRequest = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      outputs: [{ type: 'image', data: Buffer.from('legacy-image').toString('base64'), mime_type: 'image/jpeg' }],
    }), { status: 200 }))
    const sdkRequest = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_image: { data: Buffer.from('sdk-image').toString('base64'), mime_type: 'image/png' },
    }), { status: 200 }))

    const legacy = await new GeminiImageAdapter(legacyRequest as typeof fetch).generate(
      gemini('gemini-3.1-flash-image'), { prompt: 'Legacy' }, new AbortController().signal,
    )
    const sdk = await new GeminiImageAdapter(sdkRequest as typeof fetch).generate(
      gemini('gemini-3.1-flash-image'), { prompt: 'SDK' }, new AbortController().signal,
    )

    expect(Buffer.from(legacy.data).toString()).toBe('legacy-image')
    expect(legacy.mediaType).toBe('image/jpeg')
    expect(Buffer.from(sdk.data).toString()).toBe('sdk-image')
  })

  it('does not treat Gemini thought images as the generated result and reports response shape', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
      steps: [
        { type: 'thought', summary: [{ type: 'image', data: Buffer.from('thought-image').toString('base64') }] },
        { type: 'model_output', content: [{ type: 'text', text: 'I could not create that image.' }] },
      ],
    }), { status: 200 }))

    await expect(new GeminiImageAdapter(request as typeof fetch).generate(
      gemini('gemini-3.1-flash-image'), { prompt: 'An image' }, new AbortController().signal,
    )).rejects.toThrow('status=completed; stepTypes=thought,model_output; modelContentTypes=text')
  })

  it('selects adapters by provider protocol without filtering configured model IDs', () => {
    const registry = new ImageModelAdapterRegistry()
    expect(registry.supports({ ...openAI('gpt-image-1'), apiKey: undefined } as never)).toBe(true)
    expect(registry.supports({ ...gemini('gemini-3-pro-image'), apiKey: undefined } as never)).toBe(true)
    expect(registry.supports({ ...openAI('gemini-3-pro-image'), apiKey: undefined } as never)).toBe(true)
    expect(registry.capabilities({ ...openAI('gemini-3.1-flash-image'), apiKey: undefined } as never)).toEqual({
      adapter: 'openai-images', generate: true, edit: true,
    })
    expect(registry.supports({ ...gemini('gemini-3.6-flash'), apiKey: undefined } as never)).toBe(true)
    expect(registry.supports({ ...openAI('deepseek-v4-flash'), apiKey: undefined } as never)).toBe(true)
  })

  it('passes model-specific Gemini resolution validation through to the provider', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_image: { data: Buffer.from('provider-accepted').toString('base64'), mime_type: 'image/png' },
    }), { status: 200 }))
    const adapter = new GeminiImageAdapter(request as typeof fetch)
    await adapter.generate(gemini('gemini-3.1-flash-lite-image'), {
      prompt: 'A tree',
      resolution: '4K',
    }, new AbortController().signal)
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gemini-3.1-flash-lite-image',
      response_format: { image_size: '4K' },
    })
  })

  it('filters mixed tool controls to the selected adapter contract', () => {
    const request = {
      prompt: 'A portrait',
      size: '1024x1536',
      quality: 'high' as const,
      aspectRatio: '2:3',
      resolution: '2K' as const,
    }
    expect(normalizeImageRequestForAdapter('gemini-native-image', request)).toEqual({
      prompt: 'A portrait',
      aspectRatio: '2:3',
      resolution: '2K',
    })
    expect(normalizeImageRequestForAdapter('openai-images', request)).toEqual({
      prompt: 'A portrait',
      size: '1024x1536',
      quality: 'high',
    })
  })
})

function openAI(model: string): ImageModelDescriptor {
  return {
    provider: 'openai',
    model,
    protocol: 'openai-images',
    baseURL: 'https://api.openai.example/v1',
    apiKey: 'openai-secret',
  }
}

function gemini(model: string): ImageModelDescriptor {
  return {
    provider: 'google',
    model,
    protocol: 'google-generative-ai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'gemini-secret',
  }
}
