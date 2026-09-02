---
name: openpencil-design
description: 使用 StarWeave 内置 OpenPencil Companion 的实时 MCP 工具创建、读取、修改、验证并保存 .fig 或 .pen 设计。
whenToUse: 当用户要求使用 OpenPencil 创建或修改设计、查看画布、检查布局、导出或保存设计文件时使用；普通代码实现任务不要使用。
---

# OpenPencil 设计协作

## 运行方式

OpenPencil Companion 和 MCP Server 由 StarWeave 在后台启动、连接并关闭，不属于通用 MCP 设置。不要添加第二个 MCP 配置，不要读取或输出 discovery 文件、认证 Token 或请求头。

画布窗口默认隐藏，MCP 仍可在后台操作：

- 需要用户查看或交互画布时调用 `openpencil_show`；
- 用户要求收起画布时调用 `openpencil_hide`；
- 隐藏窗口不会断开 MCP，也不会停止 Companion；
- 不要使用终端启动或结束 OpenPencil 进程。

OpenPencil MCP 工具在 Harness 中使用 `mcp__openpencil-mcp__` 前缀。始终以当前会话实际公开的工具 Schema 为准。

## 最短工作流

1. 使用 `list_documents` 确认当前标签页。新建设计用 `new_document`，打开文件用 `open_file`；支持 `.fig` 和 `.pen`。
2. 读取最小必要上下文：当前选择用 `get_selection`，页面结构用 `get_page_tree`，已知节点用 `get_node`，搜索节点用 `find_nodes` 或 `query_nodes`。
3. 创建复杂界面优先使用 `render` 提交一段有明确父节点、尺寸和布局的 JSX；简单图形可使用 `create_shape`。
4. 小范围修改使用 `update_node`、`set_text`、`set_fill`、`set_stroke`、`set_layout` 等专用工具。多个已知节点的简单属性修改可使用 `batch_update`。
5. 修改后重新读取目标节点或调用 `describe`。布局风险较高时使用 `analyze_overlaps`、`analyze_spacing` 等分析工具；视觉确认可使用 `export_image`。
6. 只有用户要求保存或已有文件路径需要持久化时调用 `save_file`。不要覆盖用户未指定的文件。

## 创建规则

- `render` 的 `jsx` 参数只包含 JSX 文本，不要添加 Markdown 代码围栏。
- 顶层节点必须有明确尺寸；容器应明确布局方向、间距、padding 和对齐方式。
- 自动布局容器的子节点避免同时依赖绝对坐标。
- 重复卡片或列表项使用数据映射生成，避免大量近似调用。
- `render` 返回的节点 id 才能用于后续修改，不要根据名称或文案猜 id。
- 使用当前工具 Schema 中实际支持的 JSX 属性；失败后根据准确错误修改，不要盲目重复。

## 修改规则

- 优先尊重当前选择；选择为空时再搜索节点。
- 修改前读取目标节点以及必要的父级或同级上下文。
- 保留未被请求改变的结构、组件关系、变量绑定、页面和文件路径。
- 删除、整页替换、批量移动和覆盖保存属于高影响操作；范围不清楚时先确认。
- `batch_update` 只支持其 Schema 列出的属性，并可能返回逐项错误；不要把它当作任意事务脚本。

## 验证与展示

- 文案或单属性修改：重新读取目标节点。
- 布局修改：读取目标子树，并检查重叠、间距或边界。
- 新页面或复杂组件：结构检查后导出预览；需要用户确认时调用 `openpencil_show`。
- 截图或导出结果用于视觉验证，不能替代结构读取。

最终回复简要说明完成内容、影响的页面或节点、是否保存文件，以及画布当前是否已显示。更多工具选择见 [references/mcp-workflows.md](references/mcp-workflows.md)。
