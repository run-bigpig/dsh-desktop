---
name: openpencil-design
description: 使用 StarWeave 内置 OpenPencil Companion 的实时 MCP 工具创建、读取、修改并验证 .op 设计。
whenToUse: 当用户要求用 OpenPencil 新建设计、修改当前画布、检查布局或导出设计时使用；普通代码或网页实现任务不要使用。
---

# OpenPencil 设计协作

## 目标

通过 StarWeave 内置且已连接的 OpenPencil MCP 操作当前实时画布。形成“理解当前状态 → 最小事务修改 → 结构与视觉验证 → 必要时保存”的闭环。

工具在 Harness 中使用 `mcp__openpencil-mcp__` 前缀。始终以当前会话实际公开的工具 Schema 和服务端错误为准，不猜测参数，也不尝试把 OpenPencil 添加到通用 MCP 设置。

## 适用范围

- 新建或完善 OpenPencil UI、页面、组件、幻灯片和画布内容；
- 修改用户当前选中的节点或明确指定的节点；
- 检查布局、设计一致性、视觉结果或 lint 问题；
- 用户明确要求时保存、导出或读取 `.op` 文档。

如果 OpenPencil 工具当前不可用，说明需要先在 StarWeave 的 OpenPencil 设置中启动并连接 Companion。不要索取、显示或持久化 MCP Token，也不要启动第二个 MCP 配置。

## 最短工作流

1. 调用 `mcp__openpencil-mcp__open_document`，省略 `filePath` 以连接当前实时画布。只有用户明确指定 `.op` 文件时才传路径。
2. 根据任务读取最小上下文：
   - 修改当前选择：`get_selection`；
   - 理解顶层结构：`batch_get` 或 `snapshot_layout`；
   - 精确读取已知节点：`batch_get`、`read_nodes` 或 `get_node`；
   - 新增独立画板前需要避让现有内容：`get_canvas_bounds` 或 `find_empty_space`。
3. 新建设计优先使用 `mcp__openpencil-mcp__batch_design`；大页面按 Header、Hero、内容区、Footer 等逻辑区段拆分，每次不超过工具 Schema 的操作上限。
4. 修改既有设计时只更新相关子树。先获取真实 node id，再用 `batch_design.operations` 中的 `U/C/R/M/D` 或专用节点工具执行最小变更。
5. 修改后至少做一次结构验证；视觉结果重要时再调用 `get_screenshot`。完整交付前调用 `lint_document`，只修复与本次需求相关且证据明确的问题。
6. 只有用户明确要求写入某个文件时才调用 `save_document`。不得自行覆盖用户未指定的文件。

## 新建设计

先保留用户明确给出的平台、尺寸、语言、品牌和风格。缺失但不会实质改变结果的细节采用合理默认值；平台或画布尺寸会显著改变设计时，只问一个简短问题。

需要详细设计知识时，按需调用 `get_design_prompt` 的相关 section，例如 `layout`、`style`、`elements` 或 `design-md`，不要无条件读取全部内容。

创建重复卡片、表格行或列表时优先使用 `batch_design.script`：

- 脚本是纯 JavaScript，不带 Markdown 代码围栏；
- 仅使用全局 `I(parent, node)` 或当前 Schema 明确允许的 `K(...)`；
- `I` 返回不透明 node id 字符串，只能作为后续插入的 parent，不得给返回值赋 `x`、`y` 等属性；
- 用数据数组和循环生成重复结构，避免复制大量近似调用；
- 脚本模式只负责插入。更新、移动、删除、复制或替换使用 `operations`；
- 布局容器内的子节点不要设置 `x/y`，让 auto-layout 负责定位。

`batch_design` 是事务性的：任何一条操作失败时整批不生效。根据 `errors` 指出的准确行修正后重发完整批次；不要在失败后假设前半批已经写入。

## 修改既有设计

- 优先尊重用户当前选择；选择为空时再按名称、类型或层级定位。
- 不根据可见文案猜 node id。使用 `get_selection`、`batch_get` 或 `read_nodes` 获取真实 id。
- 更新前读取目标节点及必要的父级/同级上下文，避免破坏布局策略。
- 保留未被请求改变的内容、组件关系、变量引用、主题、交互和页面结构。
- 小改动使用 `U` 或专用 setter；只有节点类型或整体结构确需替换时使用 `R`。
- 删除、整页替换、大范围变量替换和覆盖保存属于高影响操作；目标或范围不明确时先确认。
- 失败后不要盲目重复同一调用。按当前工具 Schema 和服务端错误只修正失败字段。

## 节点与样式基础

- 文本内容字段是 `content`，不是 `text`。
- 图标节点优先使用 `type:"icon_font"` 与 `iconFontName`。在 MCP 场景不要依赖需要额外解析的空 path 图标。
- `fill` 使用数组；`stroke` 是带 `fill` 数组的对象。JSON 必须使用双引号、完整键值且无尾逗号。
- 容器明确设置 `layout`、`gap`、`padding`、对齐方式和宽高策略。
- 同一横向卡片组使用一致的宽度策略；避免在 `fit_content` 父级内使用会形成循环依赖的 `fill_container`。
- 使用语义 role 表达意图，例如 `navbar`、`button`、`card`、`hero`、`footer`、`heading`、`body-text`。
- 可复用颜色、间距和字体优先引用现有变量；不要在一次局部修改中顺手重建设计系统。

更完整的工具选择、批处理和验证契约见 [references/mcp-workflows.md](references/mcp-workflows.md)。

## 验证与收尾

验证强度与改动风险匹配：

- 文案或单属性修改：重新读取目标节点；
- 布局修改：读取目标子树并检查 `snapshot_layout`；
- 新页面、复杂组件或视觉调整：结构读取 + `get_screenshot`；
- 完整设计交付：以上检查后再运行 `lint_document`。

截图用于验证，不替代结构读取。若截图与结构结果冲突，先定位目标节点和布局数据，再做一次有界修正。不要进入无止境的“截图—重做”循环；达到用户需求且无明确阻断问题时停止。

最终回复简要说明完成了什么、修改了哪个页面/区域、是否保存到文件，以及仍需用户决定的事项。不要暴露 MCP Token、内部认证头或无关调试数据。
