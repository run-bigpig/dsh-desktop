import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkspaceGateway } from '../src/workspace/index.ts'
import { desktopRequest } from '../src/desktop/index.ts'

vi.mock('../src/desktop/index.ts', () => ({ desktopRequest: vi.fn(async () => []) }))

it('binds browser commands to the framework Agent and drops caller-supplied session/Profile fields', async () => {
  const gateway = Object.create(WorkspaceGateway.prototype) as WorkspaceGateway
  const agent = { session: { id: 'owner-a' } } as Agent
  const request = { op: 'list' as const, sessionId: 'other-b', profile: 'other-profile' }
  await gateway.browserCommand(agent, request, new AbortController().signal)
  const [, options] = vi.mocked(desktopRequest).mock.calls[0]!
  const body = JSON.parse(String(options!.body))
  expect(body).toEqual({ op: 'list', sessionId: 'owner-a' })
})
