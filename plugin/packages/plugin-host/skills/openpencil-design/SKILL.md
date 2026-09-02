---
name: openpencil-design
description: 使用 StarWeave 内置 OpenPencil Companion 的实时 MCP 工具创建、读取、修改、验证、导出并保存设计。用户要求使用 OpenPencil、操作当前画布、编辑或检查 .fig/.pen 文件、生成设计稿或展示画布时使用；普通代码实现任务不要使用。
---

# OpenPencil 设计协作

## 运行方式

OpenPencil Companion 和 MCP Server 是 StarWeave 的受管子进程：随 StarWeave 启动，窗口默认隐藏，随 StarWeave 退出。它们不属于通用 MCP 设置。不要添加第二个 MCP 配置，不要使用终端启动或结束进程，不要读取或输出 discovery 文件、认证 Token 或请求头。

画布窗口默认隐藏，MCP 仍可在后台操作：

- 需要用户查看或交互画布时调用 `openpencil_show`；
- 用户要求收起画布时调用 `openpencil_hide`；
- 隐藏窗口不会断开 MCP，也不会停止 Companion；
- `openpencil_show` / `openpencil_hide` 只控制窗口，不是设计 MCP 工具。

内置 MCP 工具通常使用 `mcp__openpencil-mcp__` 前缀。始终以当前会话实际公开的工具名和 Schema 为准，不要根据文档猜参数。

## 可用性检查

开始设计前确认当前工具目录中存在 `list_documents`、`new_document`、`get_page_tree`、`render` 或 `save_file` 等 OpenPencil MCP 工具。

- 工具存在：直接按下方工作流调用；窗口隐藏不影响后台设计操作。
- 只有 `openpencil_show` / `openpencil_hide`、没有 MCP 设计工具：调用 `openpencil_show` 一次，让桌面侧显示并尝试恢复受管 Companion；随后仅在设计工具已出现时继续。
- `openpencil_show` 返回 503，或恢复后仍无设计工具：停止设计调用，准确报告 Companion 启动/连接失败。不要声称已创建或保存，不要安装外部 OpenPencil MCP 绕过内置集成。

## 最短工作流

1. 使用 `list_documents` 发现打开的文档并记录稳定的 `document_id` 与页面 ID。新建设计用 `new_document`，打开 `.fig` / `.pen` 文件用 `open_file`，具体格式以当前 Schema 为准。
2. 后续调用显式传递工具 Schema 支持的 `document_id` 和 `page_id`，不要依赖用户当前可见的标签页或页面。新建页面后调用 `switch_page`；`create_page` 不会自动切换页面。
3. 读取最小必要上下文：当前选择用 `get_selection`，页面结构用 `get_page_tree`，已知节点用 `get_node`，搜索节点用 `find_nodes` 或 `query_nodes`。
4. 创建复杂界面优先使用 `render` 提交一段有明确父节点、尺寸和布局的 JSX；简单图形可使用 `create_shape`。
5. 小范围修改使用 `update_node`、`set_text`、`set_fill`、`set_stroke`、`set_layout`、`set_effects` 等专用工具。多个已知节点的简单属性修改可使用 `batch_update`。
6. 修改后重新读取目标节点或调用 `describe`。布局风险较高时使用可用的分析工具；视觉确认使用 `export_image`，并按需选择节点、聚焦视口或显示画布。
7. 需要持久化时调用 `save_file`。保存到新路径或覆盖范围不明确时先确认，不要把画布内存状态误报为已保存文件。

## 创建规则

- `render` 的 `jsx` 参数只包含 JSX 文本，不要添加 Markdown 代码围栏。
- 顶层节点必须有明确尺寸；容器应明确布局方向、间距、padding 和对齐方式。
- 自动布局容器的子节点避免同时依赖绝对坐标。
- 重复卡片或列表项使用数据映射生成，避免大量近似调用。
- 使用 `render` 或创建工具返回的真实节点 ID 进行后续修改，不要根据名称或文案猜 ID。
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

最终回复简要说明完成内容、目标文档/页面、是否完成结构和视觉验证、实际保存路径，以及画布当前是否显示。需要选择具体工具或诊断连接时读取 [references/mcp-workflows.md](references/mcp-workflows.md)。
