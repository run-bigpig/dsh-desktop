import { defineTool } from '@deepseek-ai/dsh-tools'

export const LOOK_AT_TOOL_NAME = 'look_at_image'
const LOOK_AT_TOOL_TITLE = '识图'

export interface LookAtImageArg {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

export function lookAtArgFromImage(image: {
  readonly attachment: {
    readonly attachmentId: string
    readonly mediaType: string
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }
}): LookAtImageArg {
  const { attachment } = image
  return {
    attachmentId: String(attachment.attachmentId),
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    width: attachment.width,
    height: attachment.height,
    ...(attachment.name === undefined || attachment.name.length === 0 ? {} : { name: attachment.name }),
  }
}

export function defineLookAtImageTool(captionImages: (
  images: readonly LookAtImageArg[],
  signal: AbortSignal,
) => Promise<ReadonlyMap<string, string>>) {
  return defineTool({
    name: LOOK_AT_TOOL_NAME,
    description: 'Caption user-attached images for a text-only model. The host calls this automatically; do not call it yourself.',
    parameters: {
      images: {
        type: 'array',
        required: true,
        description: 'Images to caption.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attachmentId: { type: 'string', required: true, description: 'Attachment id.' },
            mediaType: { type: 'string', required: true, description: 'MIME type.' },
            bytes: { type: 'integer', required: true, description: 'Encoded byte length.' },
            width: { type: 'integer', required: true, description: 'Intrinsic width.' },
            height: { type: 'integer', required: true, description: 'Intrinsic height.' },
            name: { type: 'string', description: 'Original filename.' },
          },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const images = imagesOf(args)
      const captions = await captionImages(images, exec.signal)
      return images.map(image => `[Image: ${imageName(image)}]\n${captions.get(image.attachmentId) ?? ''}`).join('\n')
    },
    presentCall(args) {
      const images = imagesOf(args)
      return {
        card: 'generic',
        title: lookAtTitle(images),
        kind: 'fetch',
        rawInput: images.map(imageName).join(', '),
      }
    },
    presentResult(args) {
      return { card: 'generic', title: lookAtTitle(imagesOf(args)) }
    },
  })
}

function imagesOf(args: unknown): LookAtImageArg[] {
  const record = asRecord(args)
  if (!Array.isArray(record?.images)) return []
  const images: LookAtImageArg[] = []
  for (const item of record.images) {
    const image = asRecord(item)
    if (typeof image?.attachmentId !== 'string' || typeof image.mediaType !== 'string') continue
    if (typeof image.bytes !== 'number' || typeof image.width !== 'number' || typeof image.height !== 'number') continue
    images.push({
      attachmentId: image.attachmentId,
      mediaType: image.mediaType,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      ...(typeof image.name === 'string' ? { name: image.name } : {}),
    })
  }
  return images
}

function imageName(image: LookAtImageArg): string {
  return image.name === undefined || image.name.length === 0 ? 'image' : image.name
}

function lookAtTitle(images: readonly LookAtImageArg[]): string {
  const names = images.map(imageName).join(', ')
  return names.length === 0 ? LOOK_AT_TOOL_TITLE : `${LOOK_AT_TOOL_TITLE} ${names}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
