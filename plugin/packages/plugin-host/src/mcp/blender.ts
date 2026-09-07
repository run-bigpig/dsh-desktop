import type { McpStdioRecord } from './document.ts'

// Official integration: https://github.com/ahujasid/blender-mcp
// uv is supplied on the desktop child PATH. Dependencies are fetched only on enable.
export function blenderMcpRecord(): McpStdioRecord {
  return {
    transport: 'stdio', serverName: 'blender', enabled: false,
    command: 'uvx',
    args: ['--python', '3.11', '--from', 'blender-mcp==1.9.1', 'blender-mcp'],
    env: {
      UV_PYTHON_PREFERENCE: 'only-managed',
      BLENDER_HOST: '127.0.0.1', BLENDER_PORT: '9876',
      DISABLE_TELEMETRY: 'true',
    },
    cwd: '', toolCallTimeoutMs: 120_000, failOnStartupError: false,
  }
}
