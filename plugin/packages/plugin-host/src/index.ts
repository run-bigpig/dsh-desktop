import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DesktopCapabilities,
  DesktopWindowState,
  MarketplaceMutationRequest,
  MarketplaceOperation,
  MarketplaceSnapshot,
} from './types.ts'

export type * from './types.ts'

const CONTROL_URL = process.env.DSH_DESKTOP_CONTROL_URL
const CONTROL_TOKEN = process.env.DSH_DESKTOP_CONTROL_TOKEN

async function desktopRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (CONTROL_URL === undefined || CONTROL_TOKEN === undefined) {
    throw new Error('DSH-DeskTop control bridge is unavailable')
  }
  const response = await fetch(new URL(path, CONTROL_URL), {
    ...init,
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(30_000),
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
