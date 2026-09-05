# 工作区设计文件

## 使用

- 在 Harness 聊天中选定工作区后，`open_design_workspace` 恢复该聊天在工作区的最近设计；没有记录时创建 `designs/Untitled-<UUID>.fig`。
- `new_document` 创建独立文档。设计窗口内从已绑定文档新建标签/设计，也继承原工作区。
- `open_file({ path: "designs/Landing.fig" })` 无弹窗打开工作区内已有文件。`open_design_workspace({ design_session_id: "..." })` 恢复已知设计。
- UI 编辑约 3 秒后自动保存；Ctrl+S 和 MCP `save_file` 等待实际文件写入。任务完成时仍应调用 `save_file`。
- 文档上方显示相对文件路径、保存中/未保存/已保存状态和失败重试。关闭标签前先保存；窗口有未保存更改时使用浏览器离开确认。
- 独立浏览器 UI、外部文件导入和另存为继续沿用原有文件流程。旧版本的外部路径记录不自动迁移，也不删除旧文件。

## 边界

Harness 官方 Agent 级 MCP 客户端通过私有请求头绑定真实聊天身份和 `agent.session.header.cwd`，不接受模型指定任意工作区根目录。原有工具策略、取消信号和结果投影继续由 Harness 管理。

`STARWEAVE_DESIGN_STATE_DIR/workspace-designs.json` 持久记录聊天、文档 UUID、固定工作区根目录和相对路径。切换工作区不会迁移已有文件。新连接恢复不依赖临时 MCP 连接 ID；不同聊天不允许共用同一已登记文件。

浏览器仅得到针对文档的随机写入能力 URL；路由要求本机同源请求。每次写入检查路径遍历、Windows 特殊路径、符号链接/目录联接；文件先写临时文件并同步，再替换目标。检测到磁盘文件在外部改变时拒绝覆盖。已保存文件被删除时不静默创建空白替代。

## 开发验证与发布

UI 源码版本为 `0.1.6`，内置插件为 `0.1.93`。UI Release 的 `starweave-ui-build.json` 必须声明 `workspaceFileProtocol: 1`。先发布匹配 UI，再构建 Desktop；旧 UI 会在构建阶段被拒绝。开发联调产物不是发布 stage。

Windows 下运行插件构建以及 `design.spec.ts`、`design-save.spec.ts`、`design-workspace.spec.ts`、`design-workspace-gateway.spec.ts`。UI 使用 `node --test scripts/workspace-save.test.mjs`、类型检查和正常构建。

真实浏览器回归位于 `tests/design-browser.e2e.ts`：显式将当前开发 UI 构建放入测试 overlay 的 `plugin-host/web/starweave-ui` 后，设置 `STARWEAVE_DESIGN_BROWSER_TEST=1`，通过 Harness 的 `vitest.e2e.config.ts` 单独运行该文件。测试使用 Windows Headless Edge 和临时工作区，覆盖 Agent 新建、真实图形自动落盘、连接重建后恢复以及手动新建；不调用模型 API。
