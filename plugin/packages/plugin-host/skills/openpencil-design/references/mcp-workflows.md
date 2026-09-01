# OpenPencil MCP 工作流参考

## 工具选择

| 目标 | 首选工具 |
|---|---|
| 连接当前实时文档 | `open_document`（省略 `filePath`） |
| 当前选择 | `get_selection` |
| 顶层或条件搜索 | `batch_get` |
| 已知节点的受控深度读取 | `read_nodes` / `get_node` |
| 空间和层级关系 | `snapshot_layout` |
| 新画板避让 | `get_canvas_bounds` / `find_empty_space` |
| 批量创建或修改 | `batch_design` |
| 分层创建大页面 | `design_skeleton` → `design_content` → `design_refine` |
| 官方设计知识 | `get_design_prompt` |
| 结构质量 | `lint_document` |
| 视觉验证 | `get_screenshot` |
| 明确路径保存 | `save_document` |

实际 Harness 工具名需要加 `mcp__openpencil-mcp__` 前缀。

## `batch_design` 模式

每次只选择 `nodes_json`、`operations` 或 `script` 之一。

### operations

适合插入与局部编辑。常用操作：

```text
root=I(null,{"type":"frame","name":"Page","layout":"vertical","width":1200})
title=I(root,{"type":"text","content":"标题","fontSize":48})
U(title,{"fontWeight":700})
copy=C(title,root,{"content":"副标题","fontSize":20})
M(copy,root,1)
D(copy)
```

- `I` 插入，`U` 更新，`C` 复制，`R` 替换，`M` 移动，`D` 删除。
- 将复杂树拆成父节点和子节点的独立插入，可获得稳定绑定并缩小错误范围。
- 单批不超过当前 Schema 指定的限制；0.8.4 建议每批最多 25 个 operations。

### script

适合循环生成重复内容：

```js
const list = I(null, {type:"frame", name:"Feature list", layout:"vertical", width:640, gap:16});
const items = ["快速", "清晰", "可靠"];
for (const label of items) {
  const row = I(list, {type:"frame", layout:"horizontal", width:"fill_container", gap:12});
  I(row, {type:"icon_font", iconFontName:"check", width:20, height:20});
  I(row, {type:"text", content:label, fontSize:16});
}
```

传给工具时只传 JavaScript 源码本身。脚本模式的绑定只在本批次内有效；需要后续批次继续修改时，从结果或重新读取中获取持久 node id。

## 分层工作流

复杂新页面可使用：

1. `design_skeleton` 创建根 frame 和 section；
2. 使用返回的真实 section id，逐段调用 `design_content`；
3. `design_refine` 对明确 root 做确定性整理；
4. 重新读取结构、截图并 lint。

不要同时并行修改存在父子依赖的区段，也不要在 section id 尚未返回前猜测它。

## 验证与恢复

- `batch_design` 失败：整批未应用。修正错误行后重发完整批次。
- 节点不存在：重新读取选择或搜索结果，不要猜新 id。
- 参数校验失败：以当前工具 Schema 为准，只修正错误字段。
- 布局异常：检查父级 layout、宽高策略、padding/gap 和子节点是否错误设置 x/y。
- 视觉异常：先用结构和布局数据缩小目标，再截图验证一次有界修正。
- 误操作且历史仍对应本次调用：可使用 `undo`；调用前确认不会撤销用户在此期间的手工编辑。

禁止为了排障读取或输出 StarWeave/OpenPencil 的认证 Token、发现文件内容或请求头。
