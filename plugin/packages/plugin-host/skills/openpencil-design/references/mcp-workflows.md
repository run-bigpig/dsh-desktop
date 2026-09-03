# OpenPencil MCP 工作流参考

## 生命周期和画布

| 目标 | 工具 |
|---|---|
| 显示 StarWeave 内嵌画布 | `openpencil_show` |
| 隐藏内嵌画布 | `openpencil_hide` |
| 查看当前文档 | `list_documents` |

SDK 画布和 MCP Runtime 由 StarWeave 内置插件管理。显示/隐藏只改变画布可见性，不启动进程、不修改 MCP 配置，也不影响已加载文档。

## 文件、文档和页面

| 目标 | MCP 工具 |
|---|---|
| 新建空文档 | `new_document` |
| 打开工作区 `.fig` | `open_file` |
| 保存文档 | `save_file` |
| 列出文档和页面 | `list_documents` / `list_pages` |
| 创建并切换页面 | `create_page` / `switch_page` |

先保存 `list_documents` 返回的 `document_id` 和页面 ID。多数工具接受可选 `document_id` / `page_id`；在 Schema 支持时显式传递，避免用户切换页面后误操作。

文件读写受当前 Harness 会话工作区边界保护。保存新文件时优先使用工作区相对路径；被拒绝时不要改用边界外绝对路径。

## 读取和定位

| 目标 | MCP 工具 |
|---|---|
| 当前选择 | `get_selection` |
| 当前页面树 | `get_page_tree` |
| 已知节点 | `get_node` |
| 按名称或类型搜索 | `find_nodes` / `query_nodes` |
| 子级或祖先 | `node_children` / `node_ancestors` |
| JSX 表示 | `get_jsx` |
| 结构摘要 | `describe` |

读取范围保持最小。已知节点 ID 时不要扫描整页；修改布局时补充读取父级和相关同级。

## 创建和修改

- `render`：以 JSX 创建完整区域、组件或页面。
- `create_shape`：创建单个基础节点。
- `update_node`：修改位置、尺寸、透明度、圆角和常用属性。
- `set_layout` / `set_layout_child`：修改自动布局和子项策略。
- `set_text` / `set_text_properties` / `set_font`：修改文字。
- `set_fill` / `set_stroke` / `set_effects`：修改视觉属性。
- `batch_update`：批量修改 Schema 明确支持的简单属性。
- `reparent_node` / `node_move` / `clone_node` / `delete_node`：修改结构。
- `group_nodes` / `ungroup_node`：调整分组。

先创建父节点并取得真实 ID，再创建或移动子节点。存在父子依赖的调用按顺序执行。

## 验证和导出

| 目标 | MCP 工具 |
|---|---|
| 重叠检查 | `analyze_overlaps` |
| 间距检查 | `analyze_spacing` |
| 色彩检查 | `analyze_colors` |
| 字体检查 | `analyze_typography` |
| 导出预览 | `export_image` |
| 导出 SVG / PDF | `export_svg` / `export_pdf` |

工具失败后重新读取目标状态，并根据当前 Schema 或准确错误调整参数。禁止读取或输出 StarWeave/OpenPencil 内部认证信息。

## 故障判断

| 现象 | 处理 |
|---|---|
| 画布隐藏且 MCP 工具可用 | 正常后台模式，继续操作 |
| 只有显示/隐藏工具，没有 `mcp__openpencil-mcp__*` | 报告内置 MCP Runtime 未连接，不安装第二套 MCP |
| MCP 报画布未连接 | 等待 SDK 初始化后重试一次；仍失败则报告 Bridge 故障 |
| MCP 报目标不存在 | 重新调用 `list_documents` / `list_pages` 并使用最新 ID |
| 文件路径被拒绝 | 改用当前会话工作区内路径 |
| `save_file` 未成功 | 不得声称文件已保存 |
