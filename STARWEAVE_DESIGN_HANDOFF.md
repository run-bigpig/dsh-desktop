# StarWeave Design 开发交接

更新时间：2026-09-04

## 仓库与分支

- 桌面端：`E:\ai\deepseek-harness-desktop`，分支 `dev-frontend`
- StarWeave UI 与 skill：`E:\ai\starweave-ui`，分支 `main`
- UI 远端：`git@github.com:run-bigpig/starweave-ui-design.git`
- OpenPencil 只读参考：`E:\ai\openpencil-starweave`

`starweave-design` skill 的权威源在 UI 仓库：

- `public/skills/starweave-design/SKILL.md`
- `public/skills/starweave-design/agents/openai.yaml`

桌面插件构建从 UI Release 的 `dist/skills/starweave-design` 装配 skill。不要把 skill 源重新放回桌面仓库。

## 本次已完成

### 原生保存与恢复

- MCP `save_file` 不再触发浏览器 `showSaveFilePicker()`，改为 Wails 3 原生保存对话框。
- 首次保存由用户选择 `.fig` 路径；同一 `design_session_id` 后续静默原子覆盖。
- 保存使用 256-bit、60 秒、单次同源上传票据，限制 256 MiB，并采用同目录临时文件、sync、rename 覆盖。
- `design_session_id -> .fig path` 持久化到 `%APPDATA%\StarWeave` 私有状态目录下的 `design-sessions.json`。
- 画布窗口关闭或页面重载后，旧的内存 Tab ID 会失效。工具层现在检测 Browser Session 未连接状态，清除旧 `document_id`，按 `design_session_id` 下载并恢复已保存 `.fig`。
- 会话恢复和新建过程使用串行锁，避免多个并行工具调用重复恢复或重复创建文档。

### 多 Agent 会话隔离

- 一个 Wails 设计窗口可以维护多个 Browser Design Session 和多个 UI Tab。
- 每个 MCP 会话绑定独立的 `design_session_id`、Document 和保存文件。
- 所有官方 OpenPencil 工具参数会被强制绑定当前 `document_id`。
- `list_documents` 只返回当前会话绑定的文档；跨会话隔离边界是 Document/文件，不是 Page。
- 已认证页面连接可通过 `open-session` 新建会话 Tab，通过 `reveal-session` 切换对应 Tab，无需重新导航整个设计窗口。

### MCP 空闲连接

根因位于 `plugin/packages/plugin-host/src/design/mcp-sessions.ts`：原实现主动设置 15 分钟空闲 TTL，过期后返回 `MCP session not found`。MCP 规范要求客户端收到旧 Session ID 的 404 后重新 Initialize，但当前 Harness 客户端没有自动完成该流程。

现已移除 Host 进程存活期间的空闲回收。MCP Session 只在客户端发送 DELETE 或插件 Host 关闭时释放，因此久未操作后可以继续调用，无需手动重连。

如果整个插件 Host 进程被重启，旧 MCP Transport 本身仍然不存在，客户端仍应按 MCP 规范重新 Initialize；服务端不能把一条缺少 InitializeRequest 的旧工具请求安全伪装成新 MCP Session。画布文件恢复与 MCP Transport 重建是两个独立层次。

### 官方 MCP 工具核对

核对来源：

- `https://openpencil.dev/programmable/mcp-server#tools-91`
- 锁定依赖 `@open-pencil/mcp@0.14.0`
- 锁定依赖 `@open-pencil/core@0.14.0`

官网列出 91 个工具。锁定的 `@open-pencil/core@0.14.0` 实际导出 105 个 `ALL_TOOLS`，比官网表额外包含较新的工具。StarWeave 的最终注册结果为 110 个工具：

- 官方 `ALL_TOOLS` 中除 `eval` 外的 104 个工具；
- 官方 `list_documents`、`save_file`、`get_codegen_prompt`；
- StarWeave 安全补充的 `open_file`、`new_document`；
- StarWeave 会话入口 `open_design_workspace`。

之前缺少 `open_file` 和 `new_document` 的原因不是官方没有实现，而是官方 `registerTools()` 只有在 `mcpRoot` 非空时才注册这两个文件工具；StarWeave 为防止 Agent 任意读取本机路径使用了 `mcpRoot: null`。

现有安全适配：

- `open_file` 已补充。它不接受 Agent 提供的任意路径，而是打开 Wails 原生 `.fig` 选择框，由用户授权文件；文件随后通过一次性下载票据进入独立设计会话，并绑定为该会话后续保存路径。
- `new_document` 已补充。它创建新的 Browser Design Session 和空白文档，不复用旧会话的保存路径。
- `eval` 保持禁用。官网明确 HTTP 模式默认禁用；它允许执行完整 Figma Plugin API JavaScript，在桌面本机 MCP 中开放会扩大任意代码执行面。

因此官网 91 项中，除明确因安全原因禁用的 `eval` 外，其余 90 项均已提供。测试同时固定当前总注册数为 110，防止再次无意遗漏条件注册工具。

### UI 与 skill

- Wails WebView2 页面启动时请求本地字体并加载 fallback pack，CanvasKit 可使用系统字体和中文 fallback。
- 恢复文件会明确装载到对应 Browser Session 的 store；`open_file`、`new_document` 后会重新绑定 Session store，避免并发 Tab 切换导致错绑。
- skill 已明确：不先输出任务列表，按空间积木流式生成；不同 Agent 会话使用不同文件；从当前对话历史复用自己的 `design_session_id`；完成前必须调用 `save_file`。
- 保存成功后的最终回复应保留 `design_session_id`，供画布窗口或 StarWeave 重启后从会话历史恢复。
- 用户取消首次保存时，Agent 必须提示画布尚未持久化，不能声称已经交付。

## 已完成验证

- UI：`pnpm run typecheck`
- UI：`pnpm run build`
- Desktop：`go test ./internal/plugin`
- 发布等价 Host/Client/Bundle 构建：成功
- 插件集成测试：3 个文件、20 个测试全部通过
- Windows PowerShell Go 测试：
  - `./internal/plugin`：通过
  - `./internal/desktop`：通过
  - `./internal/selfupdate`：通过
  - `./internal/update`：通过
- `git diff --check`：通过
- plugin-host、plugin-client、plugin-bundle 与 Go `desktopPluginVersion`：均为 `0.1.88`
- 生成插件 manifest：无 `workspace:` 残留
- UI Release skill：存在并成功装配到 plugin-host

Windows Go 测试完成后，Go 清理临时 `plugin.test.exe` 时出现过一次文件占用提示；四个测试包本身均已返回 `ok`。

## 后续环境仍需验证

本次没有构建 NSIS、打 Tag 或创建 Release。发布前仍需在 Windows 实机完成：

1. Agent 首次 `save_file` 弹出 Wails 保存框，取消与确认行为正确。
2. 后续 `save_file` 不弹框并覆盖同一文件。
3. `open_file` 弹出 Wails 打开框，只允许用户选择 `.fig`。
4. 关闭设计窗口后，在同一 Harness 会话再次调用工具，可自动恢复对应画布。
5. StarWeave 重启并重新建立 MCP Transport 后，使用对话历史中的 `design_session_id` 恢复对应文件。
6. WebView2 Runtime 支持 `queryLocalFonts()`，中文和系统字体在 CanvasKit 中正常显示；若目标机器不支持，再实现 Go 字体字节桥。
7. 多个 Agent 会话并发设计时，各自只修改自己的 Document 和文件。

## 发布边界

- 当前提交只包含源码、测试和本交接文档。
- 不包含 ignored 的 UI 本地构建 manifest、临时插件构建目录或 Harness overlay。
- 不包含 NSIS、Tag 或 GitHub Release。
- 发布时继续遵守完整 seed、Windows GUI EXE、stage 检查和 NSIS 验证流程。
