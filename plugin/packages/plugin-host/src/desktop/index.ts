import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DesktopCapabilities,
  DesktopWindowState,
  MarketplaceMutationRequest,
  MarketplaceOperation,
  MarketplaceSnapshot,
} from '../shared/types.ts'
import { registerSkinSettings } from '../skin/settings.ts'

export type * from '../shared/types.ts'

const CONTROL_URL = process.env.DSH_DESKTOP_CONTROL_URL
const CONTROL_TOKEN = process.env.DSH_DESKTOP_CONTROL_TOKEN

export async function desktopRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (CONTROL_URL === undefined || CONTROL_TOKEN === undefined) {
    throw new Error('StarWeave control bridge is unavailable')
  }
  const response = await fetch(new URL(path, CONTROL_URL), {
    ...init,
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(`desktop request failed (${response.status}): ${message}`)
  }
  return await response.json() as T
}

export class DesktopGateway extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'desktop')
    registerSkinSettings(ctx)
    ctx.get('systemPrompt')?.section({
      name: 'starweave:identity',
      order: -1000,
      text: '你的名字是小织，是一个 AI 智能体。默认使用中文回答；仅当用户明确要求使用其他语言时切换语言。',
    })
  }

  @Remote('capabilities')
  async capabilities(): Promise<DesktopCapabilities> {
    return await desktopRequest('/v1/desktop/capabilities')
  }

  @Remote('windowState')
  async windowState(): Promise<DesktopWindowState> {
    return await desktopRequest('/v1/window/state')
  }

  @Remote('minimizeWindow')
  async minimizeWindow(): Promise<void> {
    await desktopRequest('/v1/window/minimize', { method: 'POST' })
  }

  @Remote('toggleMaximizeWindow')
  async toggleMaximizeWindow(): Promise<DesktopWindowState> {
    return await desktopRequest('/v1/window/toggle-maximize', { method: 'POST' })
  }

  @Remote('closeWindow')
  async closeWindow(): Promise<void> {
    await desktopRequest('/v1/window/close', { method: 'POST' })
  }

  @Remote('catalog')
  async catalog(): Promise<MarketplaceSnapshot> {
    return await desktopRequest('/v1/marketplace/catalog')
  }

  @Remote('mutate')
  async mutate(request: MarketplaceMutationRequest): Promise<MarketplaceOperation> {
    return await desktopRequest('/v1/marketplace/operations', {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }

  @Remote('activeOperation')
  async activeOperation(): Promise<MarketplaceOperation | null> {
    return await desktopRequest('/v1/marketplace/operations/active')
  }

  @Remote('operation')
  async operation(id: string): Promise<MarketplaceOperation> {
    return await desktopRequest(`/v1/marketplace/operations/${encodeURIComponent(id)}`)
  }
}

export default DesktopGateway
