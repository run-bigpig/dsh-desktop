import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ok, registerTools } from '@open-pencil/mcp'
import { z } from 'zod'

type SendRPC = (sessionId: string | undefined, command: string, args: unknown) => Promise<unknown>

type OpenWorkspace = (
  sessionId?: string,
  reveal?: boolean
) => Promise<{ id: string; connected: boolean }>

const sessionSchema = z.string().uuid().optional().describe(
  'Existing StarWeave Design session to reveal. Omit to open or reuse this MCP connection\'s canvas.'
)

export function registerDesignTools(
  server: McpServer,
  sendRPC: SendRPC,
  openWorkspace: OpenWorkspace
): void {
  let designSessionId: string | undefined

  server.registerTool(
    'open_design_workspace',
    {
      description: 'Open or reveal the StarWeave Design canvas bound to this MCP connection.',
      inputSchema: z.object({ design_session_id: sessionSchema })
    },
    async ({ design_session_id }) => {
      const session = await openWorkspace(design_session_id, true)
      designSessionId = session.id
      return ok(session)
    }
  )

  // OpenPencil may resolve an adjacent MCP SDK copy; its public registerTool contract is compatible.
  registerTools(server as unknown as Parameters<typeof registerTools>[0], {
    enableEval: false,
    mcpRoot: null,
    sendRPC: async body => {
      if (!designSessionId) {
        designSessionId = (await openWorkspace(undefined, false)).id
      }
      const command = typeof body.command === 'string' ? body.command : ''
      if (!command) throw new Error('OpenPencil MCP request is missing its command')
      return await sendRPC(designSessionId, command, body.args ?? {})
    }
  })
}
