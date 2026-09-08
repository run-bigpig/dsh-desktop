import type { McpSettingsDocument, McpStdioRecord } from './document.ts'

// Official integration: https://github.com/ahujasid/blender-mcp
// uv is supplied on the desktop child PATH. Dependencies are fetched only on enable.
export function blenderMcpRecord(): McpStdioRecord {
  return {
    transport: 'stdio', serverName: 'blender', enabled: false,
    command: 'uvx',
    args: ['blender-mcp'],
    env: {
      BLENDER_HOST: '127.0.0.1', BLENDER_PORT: '9876',
      DISABLE_TELEMETRY: 'true',
    },
    cwd: '', toolCallTimeoutMs: 120_000, failOnStartupError: false,
  }
}

/** Saved copies of the previous default should inherit the new launch command. */
export function migrateBlenderMcpDefaults(document: McpSettingsDocument): McpSettingsDocument {
  const previousArgs = ['--python', '3.11', '--from', 'blender-mcp==1.9.1', 'blender-mcp']
  let changed = false
  const systemOverrides = document.systemOverrides.map(record => {
    if (record.serverName !== 'blender' || (record.transport ?? 'stdio') !== 'stdio'
      || (record.command ?? 'uvx') !== 'uvx' || JSON.stringify(record.args) !== JSON.stringify(previousArgs)) return record
    changed = true
    const next = { ...record }
    delete next.args
    if (next.env?.UV_PYTHON_PREFERENCE === 'only-managed') {
      const env = { ...next.env }
      delete env.UV_PYTHON_PREFERENCE
      next.env = env
    }
    return next
  })
  return changed ? { ...document, systemOverrides } : document
}
