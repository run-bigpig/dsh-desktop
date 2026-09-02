# OpenPencil MCP 工作流参考

## 生命周期与窗口

| 目标 | 工具 |
|---|---|
| 显示画布窗口 | `openpencil_show` |
| 隐藏画布窗口 | `openpencil_hide` |
| 查看后台已打开文档 | `list_documents` |

显示和隐藏只影响窗口可见性。StarWeave 始终拥有 Companion 与 MCP Server 的启动、连接和关闭生命周期；Agent 不直接管理进程。

`openpencil_show` 成功后，插件会挂载内置 MCP 连接；它本身不创建文档，也不能替代 `new_document`、`render` 或 `save_file`。503 表示桌面侧 Companion 未成功启动或连接，应停止设计操作并报告真实错误。

## 文件、文档与页面

| 目标 | MCP 工具 |
|---|---|
| 新建空文档 | `new_document` |
| 打开设计文件 | `open_file` |
| 保存文档 | `save_file` |
| 列出标签页和页面 | `list_documents` / `list_pages` |
| 创建页面 | `create_page` |
| 切换页面 | `switch_page` |

先调用 `list_documents` 并保存返回的 `document_id` 和页面 ID。多数工具接受可选的 `document_id` / `page_id`；Agent 工作流应显式传递它们。`create_page` 只创建页面，需要另行调用 `switch_page`。

文件路径受 StarWeave 工作目录边界限制。路径被拒绝时应选择工作目录内的位置，不要尝试绕过路径校验。以当前工具 Schema 为准确认可打开和保存的格式。

## 读取与定位

| 目标 | MCP 工具 |
|---|---|
| 当前选择 | `get_selection` |
| 当前页面树 | `get_page_tree` |
| 单个已知节点 | `get_node` |
| 按名称或类型搜索 | `find_nodes` / `query_nodes` |
| 节点子级或祖先 | `node_children` / `node_ancestors` |
| JSX 表示 | `get_jsx` |
| 语义化结构摘要 | `describe` |

即使当前只有一个文档，也优先显式传递目标 ID，避免窗口焦点或用户切换页面导致误操作。

## 创建与修改

- `render`：使用 JSX 创建完整区域、组件或页面，是复杂结构的首选。
- `create_shape`：创建单个基础节点。
- `update_node`：更新位置、尺寸、透明度、圆角、文本、字号等通用属性。
- `set_layout`、`set_layout_child`：调整自动布局和子项策略。
- `set_text`、`set_text_properties`、`set_fill`、`set_stroke`、`set_effects`：修改专用属性。
- `batch_update`：批量修改 Schema 明确支持的简单属性。
- `reparent_node`、`node_move`、`clone_node`、`delete_node`：结构调整。
- `group_nodes`、`ungroup_node`：分组调整。

先创建父节点并获取真实 ID，再创建或移动子节点。存在父子依赖的修改不要并行执行。

## 验证与导出

| 目标 | MCP 工具 |
|---|---|
| 重叠检查 | `analyze_overlaps`（若当前版本公开） |
| 间距检查 | `analyze_spacing` |
| 色彩检查 | `analyze_colors` |
| 字体检查 | `analyze_typography` |
| 导出视觉预览 | `export_image` |
| 导出矢量或 PDF | `export_svg` / `export_pdf` |

工具失败后重新读取目标状态，并按当前 Schema 或服务端错误修正参数。禁止读取或输出 StarWeave/OpenPencil 的认证 Token、discovery 内容或内部请求头。

## 故障判断

| 现象 | 处理 |
|---|---|
| 画布隐藏，但 MCP 工具存在 | 正常后台模式，继续操作 |
| 只有窗口工具，没有 `mcp__openpencil-mcp__*` | 调用 `openpencil_show` 一次并等待内置连接挂载 |
| `openpencil_show` 返回 503 | 报告 Companion 启动失败；不要安装第二套 MCP |
| MCP 工具报目标不存在 | 重新 `list_documents` / `list_pages`，刷新并显式传递 ID |
| `save_file` 成功前 | 只能说明画布已修改，不能说明文件已保存 |
