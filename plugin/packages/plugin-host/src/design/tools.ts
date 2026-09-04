import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ALL_TOOLS } from '@open-pencil/core/tools'
import type { ParamDef, ParamType } from '@open-pencil/core/tools'
import { z } from 'zod'

type SendRPC = (sessionId: string | undefined, command: string, args: unknown) => Promise<unknown>

const sessionSchema = z.string().uuid().optional().describe(
  'Design session returned by open_design_workspace. Omit to use the current StarWeave Design session.'
)

export function registerDesignTools(server: McpServer, sendRPC: SendRPC, openWorkspace: (sessionId?: string) => Promise<{ id: string; connected: boolean }>): void {
  server.registerTool(
    'open_design_workspace',
    {
      description: 'Open or reuse the authenticated StarWeave Design browser workspace.',
      inputSchema: z.object({ design_session_id: sessionSchema })
    },
    async ({ design_session_id }) => ok(await openWorkspace(design_session_id))
  )

  server.registerTool(
    'list_design_documents',
    {
      description: 'List documents and pages currently open in a StarWeave Design browser session.',
      inputSchema: z.object({ design_session_id: sessionSchema })
    },
    async ({ design_session_id }) => rpcResult(await sendRPC(design_session_id, 'list_documents', {}))
  )

  for (const definition of ALL_TOOLS) {
    const changesDocument = (definition as typeof definition & { changesDocument?: boolean }).changesDocument
    const mutates = changesDocument ?? definition.mutates ?? false
    const shape: Record<string, z.ZodType> = { design_session_id: sessionSchema }
    for (const [name, parameter] of Object.entries(definition.params)) shape[name] = paramToZod(parameter)
    server.registerTool(
      definition.name,
      {
        description: `${definition.description} The browser workspace opens automatically when needed.`,
        inputSchema: z.object(shape),
        annotations: {
          readOnlyHint: !mutates,
          destructiveHint: mutates
        }
      },
      async (args: Record<string, unknown>) => {
        const { design_session_id, ...toolArgs } = args
        const sessionId = typeof design_session_id === 'string' ? design_session_id : undefined
        return rpcResult(await sendRPC(sessionId, 'tool', { name: definition.name, args: toolArgs }))
      }
    )
  }
}

function paramToZod(parameter: ParamDef): z.ZodType {
  const factories: Record<ParamType, () => z.ZodType> = {
    string: () => parameter.enum
      ? z.enum(parameter.enum as [string, ...string[]])
      : z.string(),
    number: () => {
      let schema = z.coerce.number()
      if (parameter.min !== undefined) schema = schema.min(parameter.min)
      if (parameter.max !== undefined) schema = schema.max(parameter.max)
      return schema
    },
    boolean: () => z.boolean(),
    color: () => z.string(),
    'string[]': () => z.array(z.string()).min(1)
  }
  const schema = factories[parameter.type]().describe(parameter.description)
  return parameter.required ? schema : schema.optional()
}

function rpcResult(value: unknown) {
  const envelope = isRecord(value) ? value : { result: value }
  if (envelope.ok === false) return fail(new Error(String(envelope.error ?? 'Design command failed')))
  const result = envelope.result ?? envelope
  if (isRecord(result) && typeof result.base64 === 'string' && typeof result.mimeType === 'string') {
    return { content: [{ type: 'image' as const, data: result.base64, mimeType: result.mimeType }] }
  }
  return ok(result)
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function fail(error: Error) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }], isError: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
