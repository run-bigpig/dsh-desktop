import { defineTool } from '@deepseek-ai/dsh-tools'

export interface OpenPencilWindowControl {
  show: () => Promise<string>
  hide: () => Promise<string>
}

export function defineOpenPencilControlTools(control: OpenPencilWindowControl) {
  const output = {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
  return [
    defineTool({
      name: 'openpencil_show',
      description: '显示 StarWeave 内置 OpenPencil 画布窗口。仅在需要用户查看或交互画布时调用。',
      parameters: {},
      output,
      isConcurrencySafe: () => false,
      execute: () => control.show(),
    }),
    defineTool({
      name: 'openpencil_hide',
      description: '隐藏 OpenPencil 画布窗口，但保持后台 MCP 连接和 StarWeave 托管进程继续运行。',
      parameters: {},
      output,
      isConcurrencySafe: () => false,
      execute: () => control.hide(),
    }),
  ]
}
