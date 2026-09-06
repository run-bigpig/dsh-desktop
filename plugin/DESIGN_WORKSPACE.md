# 设计会话

## 用户流程

- 在 Harness 新会话页或会话模式切换器中选择“设计模式”。
- 空白设计会话会在原生 Agent 输入框上方显示画布入口；会话开始后，设计画布成为会话主体，输入框继续固定在下方。
- 用户点击“新建设计”或“打开文件”后，当前会话的 OpenPencil MCP 才能操作画布。
- 新建、打开和保存始终由用户在画布工具栏中触发。没有自动保存，未保存状态会明确显示，替换文档或离开页面前会提示。

## 隔离和权限

每个 Harness 会话维护独立的内存文档和随机浏览器连接令牌。Agent 级 MCP 连接由 Host 绑定到 `agent.session.id`，工具调用会强制使用该会话当前打开的文档。另一个会话未连接画布时不能复用当前文档。

Agent 不注册 `open_file`、`new_document`、`save_file` 或 `eval`。OpenPencil 的其他官方工具通过 Harness 原生 Agent MCP 客户端执行，因此保留工具策略、取消和结果投影。设计 preset 使用随插件安装的 OpenPencil 官方 Skill。

画布文档仅在当前 Desktop 进程内保留。用户需要通过“保存”写入 `.fig`；重新打开应用或会话后，由用户再次选择文件。插件不会建立工作区持久化目录，也不会创建、恢复或自动写入设计文件。

## 源码和构建

设计 UI 源码位于 `plugin/packages/plugin-design-ui`，与 `plugin-host`、`plugin-client` 和 `plugin-bundle` 一同版本化。`plugin/scripts/build-against-harness.mjs` 针对锁定的 Harness commit 执行类型检查和 Vite 构建，并将 JavaScript、CSS、CanvasKit WASM 与 OpenPencil 自带字体放入 `plugin-host/web/starweave-design`。

内置插件四个 package 的版本必须一致，并与 Go 的 `desktopPluginVersion` 同步。发布门禁包括 Design UI 类型检查和构建、Host/Client/Bundle 编译、设计会话隔离测试、Windows Go 测试、完整 seed 流程与已安装状态 smoke。
