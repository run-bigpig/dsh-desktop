---
name: starweave-design
description: 使用 StarWeave Design 的 MCP 画布把文字描述、截图或线框图实时转化为结构清晰的页面，编排互不重叠的空间区域并行生成，并根据当前选区用自然语言完成局部修改、验证与保存。用户要求创建页面、组件、视觉稿、重做界面、修改选中元素或参考图片设计时使用。
---

# StarWeave 实时设计

## 核心原则

直接在画布上工作，不要先输出任务列表、检查清单或长篇设计计划。意图足够明确后，立即调用 `open_design_workspace`。后续官方 OpenPencil 工具会自动复用绑定到当前 MCP 连接的画布。

把页面当作一组稳定的空间积木，而不是一堆散落图层：

- 先建立根 Frame 和命名清楚的区域骨架，再填充内容。
- 一个 `render` 生成一个用户能辨认的完整块，例如导航栏、Hero、指标卡组或表单；不要退化成每次只画一个无意义的小原子。
- 每个调用返回后，该块就应出现在画布上。继续构建下一个块，形成可观察的流式生成过程。
- 不要用一次巨大的 `render` 填满整页。一次性整页 JSX 会失去流式反馈，也难以定位布局问题。
- 优先使用 Frame 自动布局、统一间距和稳定父子关系。除非参考图明确需要自由排版，否则不要靠大量绝对坐标拼页面。
- 保留用户没有要求修改的结构和样式。

## 工具策略

主要工具按用途选择：

- 打开与上下文：`open_design_workspace`、`list_documents`、`get_current_page`、`get_page_tree`、`get_node`。
- 查找与选区：`get_selection`、`find_nodes`、`query_nodes`、`select_nodes`。
- 生成：`render`。使用 `parent_id` 向稳定容器填充，使用 `replace_id` 替换完整区域。
- 精确修改：`set_text`、`set_fill`、`set_stroke`、`set_layout`、`set_layout_child`、`set_radius`、`set_text_properties`、`update_node`、`batch_update`。
- 结构调整：`reparent_node`、`node_move`、`node_resize`、`clone_node`、`delete_node`、`arrange`。
- 检查：`describe`、`analyze_overlaps`、`analyze_spacing`、`analyze_colors`、`analyze_typography`、`export_image`。
- 视口：只在需要查看整体或定位目标时使用 `viewport_zoom_to_fit`、`viewport_get`、`viewport_set`。
- 保存：用户要求保存，或明确要交付当前设计文件时使用 `save_file`。不要声称已保存，除非工具成功返回。

`render` 使用 OpenPencil JSX。例如：

```jsx
<Frame name="Feature Card" w={320} flex="col" gap={16} p={24} bg="#FFFFFF" rounded={16}>
  <Text size={18} weight="bold" color="#111827">实时协作</Text>
  <Text size={14} color="#6B7280">让想法在画布上逐块成形。</Text>
</Frame>
```

常用标签包括 `Frame`、`Rectangle`、`Ellipse`、`Text`、`Line`、`Icon`、`Group` 和 `Section`。尺寸使用 `w`、`h`，自动布局使用 `flex="row|col"`、`gap`、`p`、`px`、`py`、`justify`、`items`，外观使用 `bg`、`stroke`、`strokeWidth`、`rounded`、`shadow`。图标使用如 `<Icon name="lucide:sparkles" size={20} color="#FFFFFF" />`。

## 文字转设计

收到页面描述后按以下执行顺序直接操作画布，不要把顺序作为任务列表回复给用户。

1. 调用 `open_design_workspace`，随后读取当前文档、页面和页面树。已有页面时先判断是续改还是新建，避免在旧内容上盲目叠加。
2. 从用户描述提取少量一致的设计令牌：画布宽度、背景、主色/中性色、字体层级、间距阶梯、圆角与阴影。没有品牌要求时保持克制，不随意混用多套风格。
3. 第一个 `render` 只创建根页面和顶层空间骨架。骨架应包含命名明确、互不重叠的空区域，例如 `Header`、`Hero`、`Main Content`、`Footer`。使用纵向或网格自动布局确定空间关系。
4. 读取根节点或页面树，确认各区域的真实 ID。不要猜测 ID。
5. 分区填充内容。每次 `render(parent_id=区域ID)` 完成一个清晰的视觉积木；调用完成后再继续推进可见进度。
6. 对重复卡片、列表项和按钮维持同一组件语法、间距、圆角与层级。适合时先创建一个正确样板，再使用 `clone_node` 和局部文本修改，避免每个副本随机漂移。
7. 完成主要区域后检查整体层级、留白和对齐，再做局部修正。不要在结构未稳定时过早堆叠装饰。

骨架示意：

```jsx
<Frame name="Product Landing" w={1440} flex="col" bg="#F7F8FC">
  <Frame name="Header" w="fill" h={72} flex="row" items="center" px={80} />
  <Frame name="Hero" w="fill" h={620} flex="row" gap={48} items="center" px={80} py={72} />
  <Frame name="Features" w="fill" flex="col" gap={32} px={80} py={96} />
  <Frame name="Footer" w="fill" h={240} flex="col" gap={24} px={80} py={48} />
</Frame>
```

这里只创建空间结构。拿到 `Header`、`Hero`、`Features`、`Footer` 的真实 ID 后，再分别向这些容器添加内容。

## 空间编排器

复杂页面采用“依赖串行、空间并行”的编排规则：

- 根 Frame 和顶层骨架必须先完成，因为所有后续区域依赖这些父节点 ID。
- 父容器的真实 ID 返回后，不同 `parent_id`、互不重叠、互不引用的区域可以并行调用 `render`。例如 Hero 内容与 Footer 内容可并行生成。
- 同一父容器下的多个插入不要并行；自动布局中的插入顺序可能因此不确定。
- 修改同一节点、替换同一区域、依赖前一步新节点 ID、或跨区域移动节点时必须串行。
- 并行任务只负责各自空间容器，不能顺手修改根页面、共享样式节点或其他区域。
- 一轮并行完成后统一读取 `get_page_tree`，再运行结构和视觉检查。若发现冲突，先修复空间关系，再继续下一层并行。

推荐的分解粒度是“区域中的完整积木”，而不是所有原子节点并发。每个区域内部仍按标题、内容组、操作区等父子依赖逐步构建。这样用户能看到页面持续生长，同时不会因为无边界并发而变得杂乱。

## 设计修改

用户描述“把这个改成……”“选中的按钮……”等修改时：

1. 先调用 `get_selection`。
2. 有选区时读取选中节点的 `get_node`，必要时读取父节点和相邻节点，理解它在布局中的约束。
3. 将意图映射到最小的专用工具：
   - 文案改动使用 `set_text`。
   - 填充、描边、圆角分别使用 `set_fill`、`set_stroke`、`set_radius`。
   - 字体层级使用 `set_text_properties`。
   - 容器与子项布局使用 `set_layout`、`set_layout_child`。
   - 其他单项属性使用 `update_node`，同类多节点修改使用 `batch_update`。
   - 整块重做才使用 `render(replace_id=...)` 或 `node_replace_with`。
4. 没有选区时使用 `find_nodes` 或 `query_nodes` 按名称、类型和页面上下文定位。只有在候选无法唯一确定、不同选择会产生明显不同结果时才向用户确认。
5. 修改后读取目标节点并检查它与父容器、同级元素的关系。不要为了一个颜色或文案变化重建整个页面。

## 视觉输入

Harness 会先把用户附加的截图或线框图转换为 `[Image: 文件名]` 描述块。直接使用其中的视觉信息，不要主动调用 `look_at_image`，不要重复向用户宣告“正在识图”。

- 截图参考：提取布局区域、视觉层级、色彩、字体尺度、间距、圆角、阴影、密度和组件模式。优先复现设计语言与空间关系，不要机械复制截图噪点。
- 线框图参考：优先还原信息架构、区块尺寸、顺序和交互位置，再应用与用户要求一致的视觉系统。
- 截图与文字冲突时，以用户文字中的明确要求为准；其余部分参考截图。
- 仍然按“骨架 → 获取区域 ID → 独立区域并行填充 → 校验”的流程生成。
- 不要把参考图片本身插入画布，除非用户明确要求该图片成为页面内容。
- 如果图像描述缺失关键内容，且不同推断会显著改变设计，再提出一个简短问题；可合理推断时直接继续。

## 质量校验

完成一轮设计后：

1. 使用 `get_page_tree` 或 `describe` 确认区域层级清楚、命名可辨认，元素位于正确父容器。
2. 使用 `analyze_overlaps` 查找非预期遮挡，使用 `analyze_spacing` 检查节奏和对齐。
3. 使用 `analyze_colors`、`analyze_typography` 检查颜色和字体是否形成一致系统。
4. 必要时使用 `export_image` 查看整体视觉结果，并用专用修改工具修正具体问题。
5. 只修复有证据的问题。装饰性重绘不能破坏已经稳定的结构。

最终页面应像由少量一致的空间积木搭成：根页面组织区域，区域组织组件，组件内部才是文字、图标和形状。流式反馈来自这些完整积木逐块出现在画布上，而不是一次性倾倒整页或让大量散点同时变化。
