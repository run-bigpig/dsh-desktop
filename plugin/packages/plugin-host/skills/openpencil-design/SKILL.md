---
name: openpencil-design
description: 使用 StarWeave 内置 OpenPencil SDK 画布和 openpencil-mcp 工具创建、读取、修改、验证、导出并保存 .fig 设计。用户要求使用 OpenPencil、制作或编辑设计稿、操作当前画布、检查 .fig 文件、导出设计结果或向用户展示画布时使用；普通代码实现任务不要使用。
---

# OpenPencil 设计协作

## 运行模型

将 OpenPencil 视为 StarWeave 内置设计能力：SDK 画布和 MCP Runtime 随内置插件启动和关闭，没有 Companion 应用、独立窗口或需要手动维护的第二套 MCP 配置。

- 画布默认隐藏，但会在当前 Harness 会话内初始化并连接 MCP。
- 仅在用户需要查看或直接操作画布时调用 `openpencil_show`。
- 用户要求收起画布时调用 `openpencil_hide`；隐藏不会卸载文档或断开 MCP。
- `openpencil_show` 和 `openpencil_hide` 只控制 StarWeave 内嵌画布，不创建、修改或保存设计。
- 不读取、输出或要求用户配置 MCP 地址、认证 Token、discovery 文件或请求头。

OpenPencil MCP 工具通常使用 `mcp__openpencil-mcp__` 前缀。始终使用当前会话实际公开的工具名和 Schema，不根据文档猜参数。

## 开始前检查

确认工具目录存在 `list_documents`、`new_document`、`get_page_tree`、`render`、`save_file` 等 OpenPencil MCP 工具。

- 工具存在：直接执行设计工作流，画布是否显示不影响 MCP 操作。
- 只有 `openpencil_show` / `openpencil_hide`：停止设计调用并报告“StarWeave 内置 OpenPencil MCP Runtime 未连接”；不要把显示画布当作修复连接的手段。
- 工具存在但返回画布未连接：等待内置 SDK 初始化后重试一次；仍失败则报告内置画布与 MCP Bridge 连接失败。
- 不安装外部 OpenPencil、不启动终端进程，也不添加同名 MCP 配置绕过故障。

## 核心工作流

1. 调用 `list_documents` 获取当前文档、`document_id`、页面 ID 和文件路径；新建设计调用 `new_document`，打开工作区内 `.fig` 调用 `open_file`。
2. 后续调用在 Schema 支持时显式传递 `document_id` 和 `page_id`。创建页面后调用 `switch_page`，不要假设 `create_page` 会自动切换。
3. 只读取必要上下文：选择使用 `get_selection`，页面使用 `get_page_tree`，已知节点使用 `get_node`，搜索使用 `find_nodes` 或 `query_nodes`。
4. 复杂区域优先使用 `render` 创建有明确父节点、尺寸和布局的 JSX；单个基础元素使用 `create_shape`。
5. 小范围修改使用 `update_node`、`set_text`、`set_fill`、`set_stroke`、`set_layout`、`set_effects` 等专用工具；多个简单修改使用 `batch_update`。
6. 修改后重新读取目标节点或调用 `describe`。布局风险较高时运行相应分析工具；视觉确认使用 `export_image`，需要用户确认时再调用 `openpencil_show`。
7. 需要持久化时调用 `save_file`，并确认工具返回的实际路径。未成功保存前，只能说明内存画布已修改。

## 操作约束

- `render` 的 JSX 参数只传 JSX 文本，不添加 Markdown 代码围栏。
- 顶层节点设置明确尺寸；容器明确布局方向、间距、padding 和对齐方式。
- 自动布局子节点不要同时依赖绝对坐标。
- 使用工具返回的真实节点 ID，不根据名称或文案猜 ID。
- 修改前读取目标及必要的父级或同级上下文，保留未被要求改变的结构、组件关系、变量绑定、页面和文件路径。
- 删除、整页替换、批量移动和覆盖已有文件属于高影响操作；范围不明确时先确认。
- 文件路径必须位于当前 Harness 会话工作区内；路径被拒绝时选择工作区内位置，不尝试绕过边界。

## 验证与交付

- 文案或单属性修改：重新读取目标节点。
- 布局修改：读取目标子树并检查重叠、间距和边界。
- 新页面或复杂组件：完成结构检查后导出预览。
- 截图或导出用于视觉验证，不能替代结构读取。

最终回复说明完成内容、目标文档和页面、结构/视觉验证结果、实际保存路径，以及画布当前是否显示。需要选择具体工具或诊断连接时读取 [references/mcp-workflows.md](references/mcp-workflows.md)。
