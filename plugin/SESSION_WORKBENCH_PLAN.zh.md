# 会话工作台实施计划

状态：实施中
适用分支：`dev-frontend`
适用 Harness：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（`dsh-v0.1.1-rc.2`）

当前进度：阶段 1–6 已完成；阶段 7 的批准版本投影、源码构建和自动化测试已完成，等待新版 Desktop/Harness 安装态部署后执行最终 smoke。

## 目标

在内置 `plugin-client` 中增加只服务当前会话的工作台，让人类与 Agent 在同一会话上下文中协作处理图片任务，同时为人类提供工作区文件浏览和可选的系统 Git 界面。

实现必须遵守以下边界：

- 不修改、复制或 vendor Harness 应用源码。
- 不替换 Harness Web、`sidebar`、`details` 或会话页面。
- 不引入 iframe、Wails 页面绑定、DOM 注入或第二套插件系统。
- 文件目录与 Git 只提供给人类 UI，不注册为 Agent Tool。
- 图片任务由 Host 保存并由人类和 Agent 共享，Agent 不能主动打开工作台。
- 不在运行时内置、下载或依赖 Git；仅在系统 Git 可用时显示 Git Tab。

## 验收标准

1. 工作台通过 Harness 官方 slot 挂载，能够打开、关闭，并随当前会话切换。
2. Files Tab 展示当前会话 `cwd` 下的文件树；文件可拖入当前会话输入区并生成官方 `@文件` 引用，不自动发送。
3. 系统不存在 Git 时不显示 Git Tab；存在时可查看状态和 Diff，并执行 Stage、Unstage、Commit。
4. 视觉模型和生图模型均从 Harness Models 中选择，凭据不会进入 Client。
5. Agent 可以调用图片生成、编辑、继续编辑和版本查询工具；生成图片通过官方图片块显示在聊天流。
6. 点击聊天图片的编辑按钮后才打开 Image Studio；人类可调整画布、移动或缩放原图并直接标记修改约束。
7. 图片编辑请求回到当前会话由 Agent 执行；批准的新图片通过版本投影视觉替换旧图，但不改写 Harness 追加式历史。
8. Host、Client、Bundle 均能针对 pinned Harness 构建，生成包无 `workspace:`，相关测试和 `git diff --check` 通过。

## 架构

```text
当前 Harness 会话
├─ 聊天流
│  ├─ Agent 图片工具
│  ├─ Tool Result ImageBlock
│  └─ 消息图片编辑入口
└─ Session Workbench
   ├─ Files                人类专用
   ├─ Git / Diff           人类专用、系统 Git 可选
   └─ Image Studio
      ├─ 人类编辑 UI
      ├─ Host ImageTaskService
      └─ Agent 图片工具
```

推荐扩展点：

- `conversation.session.header.utilities`：工作台入口。
- `details`：右侧工作台，使用 Harness 原生列布局压缩聊天区。
- `conversation.input.dock`：拖动工作区文件时显示会话级 Drop Dock。
- `conversation.message.images`：保留官方图片体验并增加编辑入口。
- `tool.call.toolview`：图片工具结果展示。

## 状态所有权

### Client 本地状态

- 工作台是否打开。
- 当前 Tab。
- 文件树展开状态。
- 画布缩放、选中标记、临时工具状态。

这些状态按 `sessionId` 隔离，切换会话时不串联。

### Host 共享状态

- `ImageEditDraft`。
- `ImageTask`。
- 图片版本链。
- 模型执行状态和错误。

共享对象包含 `revision` 和 `updatedBy: human | agent`，所有修改使用 CAS，禁止静默 last-write-wins。

## Files Tab

第一版范围：

- 懒加载当前会话工作区目录树。
- 支持展开、折叠和刷新。
- 路径统一为工作区相对路径。
- 不新增创建、删除、移动、重命名等文件操作。
- 不遍历符号链接，不允许路径逃逸工作区。

### 拖入会话

内部拖动使用独立 MIME，只携带 `sessionId`、相对路径和文件类型。Drop 时必须确认目标仍是原会话。

引用生成复用 Harness 官方能力：

1. 使用 `formatFileMention({ path, kind: 'file' }, false)`。
2. 构造 `source: 'reference'` 的 `ReferenceInsert`。
3. 在当前会话作用域触发 `slash/input-insert-reference`。
4. 使用草稿末尾的零宽 `TokenSpan` 和最新 `draftRev`。
5. 多文件逐个插入，等待每次 revision 更新。

第一版固定追加到草稿末尾，不读取 textarea DOM 来模拟鼠标落点。拖动期间通过官方 `conversation.input.dock` 在输入框上方显示明确的接收区域；目录节点只用于展开，不可拖入会话。

## Git / Diff Tab

- Host 使用系统 `git`，不打包、不下载 Git。
- 启动或首次打开工作区时检测 `git --version`。
- 无 Git：不注册或不显示 Tab。
- 有 Git、当前目录不是仓库：显示空状态，不自动初始化。
- 所有命令使用参数数组和 `git -C <workspace>`。
- Windows 子进程隐藏控制台窗口。

第一版功能：

- 当前分支及仓库状态。
- Staged、Unstaged、Untracked。
- 文件 Diff。
- Stage、Unstage、Commit。

第一版不提供 discard、reset、clean、force checkout、rebase、push、pull 或 init。

## 模型与凭据

视觉识别和图片生成统一读取 Harness 模型目录：

- `ctx.llm.listProviders()`
- `ctx.llm.listModels(provider)`
- `ctx.llm.resolveModelInfo(provider, model)`
- `ctx.llm.listConfigurableProviders()`
- `llm/adapters-updated`
- `ctx.credentials.resolve()`

Client 只读取模型元数据，凭据只在 Host 每次执行时解析。

视觉设置从独立 Base URL、API Key、模型名迁移为 `{ provider, model }`，仅展示声明支持图片输入的 Harness 模型。旧密钥不自动删除或猜测迁移目标。

Harness 当前不声明图片输出、编辑和扩图能力，因此插件维护 `ImageModelAdapterRegistry`。生图下拉框只展示同时满足以下条件的模型：

```text
Harness 已配置模型 ∩ ImageModelAdapterRegistry 已支持模型
```

每个 Adapter 显式声明生成、编辑、扩图、尺寸、比例和输入图片限制，不根据模型名猜测协议。首批 Adapter 支持 OpenAI GPT Image 与 Google Gemini Nano Banana，并分别使用官方 Images API 与 Gemini Interactions API。

## Image Studio

只有点击会话图片悬浮的“编辑”按钮才打开工作台并载入图片。Agent 不能主动操作 UI。

画布能力：

- 拖动四边和四角调整输出尺寸。
- 精确宽高、比例锁定和预设。
- 原图独立移动、缩放、居中和重置。
- 扩图区域使用棋盘格预览，但棋盘格不提交给模型。
- 请求前验证 Adapter 尺寸和比例限制，不静默改变构图。

标记能力：

- 矩形、圆形、画笔、高亮、箭头、文字、删除叉号和扩展方向。
- 颜色、粗细、撤销、重做和清空。
- 不提供单独 Mask 编辑器。

内部保存干净原图、标注指导图、矢量标注、画布几何和提示词。旧模型如需 Mask，由 Adapter 内部派生。

## 图片任务流程

```text
点击消息图片“编辑”
→ 调整画布、原图位置和标记
→ 输入编辑要求
→ Host 保存 ImageEditDraft
→ 将同一份指导图通过 Harness 官方 Composer 图片附件接口放回当前会话
→ 编辑要求作为普通输入文本，不显示内部 draft id 或 revision
→ Agent 调用 image_edit；未指定任务时自动使用当前会话最新 ImageEditDraft
→ 结果图片显示在聊天流
→ 设为当前版本，或再次编辑
```

工作台只构造精确编辑约束，不建立第二套模型对话。

建议数据结构：

```ts
interface ImageEditDraft {
  id: string
  sessionId: string
  revision: number
  sourceImage: ImageAssetRef
  annotatedGuideImage: ImageAssetRef
  annotations: Annotation[]
  canvas: CanvasGeometry
  instruction: string
  updatedBy: 'human' | 'agent'
}
```

Agent 图片工具：

- `image_generate`
- `image_edit`
- `image_task_get`
- `image_task_continue`
- `image_versions`

不提供目录、Git 或打开工作台工具。

## 聊天展示和图片版本

- Sender 图片添加、删除、预览、上传和发送后消息图片块均复用 Harness 官方附件能力；插件不实现第二套附件协议。
- ImageEditDraft 仅作为内部编辑状态持久化，不使用可见 `@image-draft` 文本引用。
- 工具结果使用 Harness 官方 `ImageBlock`。
- 图片通过附件服务保存。
- 为图片工具注册 keyed `tool.call.toolview`，覆盖默认非文本工具行的不足。
- 使用官方 `conversation.message.images` slot shadowing 增加编辑入口，保留 Gallery、Lightbox、加载、错误和可访问性行为。
- 不导入 Harness 内部 `src` 路径，不修改消息 DOM。

“替换原图”使用版本投影，不物理修改历史：

1. 新结果先作为新消息图片进入聊天流。
2. 用户批准后记录当前版本映射。
3. 图片 renderer 将旧图片解析为批准版本。
4. 后续模型请求将旧引用解析为批准版本。
5. 原图和旧版本保持可恢复。

## 包职责

### plugin-host

- 工作区目录读取和路径校验。
- 系统 Git 检测和命令执行。
- Harness 模型及凭据访问。
- Image Adapter Registry、任务服务和 Agent Tools。
- 图片附件、版本和会话事件。

### plugin-client

- 工作台入口、抽屉和 Tabs。
- 文件树和官方引用拖放。
- Git/Diff UI。
- 模型设置。
- Image Studio、画布和标记。
- 消息图片入口和图片 ToolView。

### plugin-bundle

- 组合 Host、Client 和所需 Harness 公共依赖。
- 保证所有内置包版本同步。
- 不携带 Harness 源码补丁。

## 实施阶段

### 阶段 1：合约和工作台骨架

- 固化 slots、session、reference、LLM、credentials、attachments 和 tool rendering 合约。
- 增加工作台 launcher、drawer、session 状态和空状态。
- 增加 pinned Harness 合约测试。

### 阶段 2：Files 与官方引用拖放

- 增加 Host 工作区目录 Remote。
- 实现懒加载文件树。
- 实现内部文件拖放和 `@文件` 插入。
- 验证多文件、跨会话和失效路径。

### 阶段 3：系统 Git

- 条件显示 Git Tab。
- 实现 status、diff、stage、unstage 和 commit。
- 验证无 Git、非仓库和隐藏子进程。

### 阶段 4：模型设置和视觉迁移

- 接入 Harness Models 和 credentials。
- 迁移视觉设置。
- 增加生图模型设置和 Adapter 过滤。

### 阶段 5：图片任务与 Agent Tools

- 实现任务、草稿、revision CAS 和附件保存。
- 注册图片生成、编辑、继续和版本工具。
- 返回官方图片块。

### 阶段 6：Image Studio 与聊天集成

- 实现画布、标记和发送到会话。
- 增加消息图片编辑入口和 ToolView。
- 完成多轮编辑。

### 阶段 7：版本投影和发布验证

- 实现批准版本映射及后续 LLM 输入解析。
- 同步 Host、Client、Bundle 和 Go 插件版本。
- 完成插件构建、测试、Windows Go 测试和安装态 smoke。
- 除非明确要求，不构建 NSIS。

## 当前实施记录

- [x] 完成架构收敛和 Harness 官方引用链路核对。
- [x] 将计划落盘。
- [x] 阶段 1：工作台骨架、会话绑定和 pinned Harness 合约编译。
- [x] 阶段 2：Files 懒加载目录树与官方引用拖放。
- [x] 阶段 3：系统 Git 状态、Diff、Stage、Unstage、Commit 源码实现。
- [x] 阶段 4：模型设置和视觉迁移。
- [x] 阶段 5：图片任务与 Agent Tools。
- [x] 阶段 6：Image Studio 与聊天集成。
- [ ] 阶段 7：版本投影和发布验证（源码、构建和测试已完成；等待新版 Desktop/Harness 安装态部署后执行最终 smoke）。

当前验证结果：

- Host、Client 和 Bundle 已针对 pinned Harness `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 完成构建，`imageWorkbench` Draft 与批准版本 Typert Remote 已生成。
- 批准版本使用 Harness 正式 Session Surface replacement 投影到后续 LLM 历史，原追加式会话记录不改写；Session Projection 向客户端广播原附件到批准附件的映射，支持 revision CAS、会话隔离、采用旧版本和恢复原图。
- OpenAI Images、Gemini Interactions、模型专属参数自动筛选、任务与草稿持久化、批准投影、revision CAS、会话隔离、消息图片入口、Image Studio 引用和官方 ImageBlock 均已有测试；全部插件测试共 21 个文件、105 项通过。
- 图片请求会按实际 Adapter 筛选参数：Gemini 忽略 OpenAI 的 `size`、`quality`，OpenAI 忽略 Gemini 的 `aspect_ratio`、`resolution`，同时保留各 Adapter 自身的能力校验。
- Gemini Interactions REST 响应支持新版 `steps/model_output/content`、旧版 `outputs` 和 SDK `output_image` 三种结构；思考步骤中的图片不会误作最终结果。
- Harness 中通过 OpenAI-compatible Provider 配置的显式 Gemini 图片模型会使用该 Provider 的 Images API，Google Provider 下的同模型仍使用原生 Interactions API。
- 生图、编辑和继续编辑的会话卡片已增加显影式加载状态、无障碍状态播报和减少动态效果适配。
- 生图和视觉模型目录不再按模型 ID 或图片能力声明过滤；Harness 已配置模型全量可选，运行时由对应 Provider 返回真实能力错误。
- 生图工具成功后直接在卡片内复用会话图片画廊展示结果，并保留预览、图片工作台入口和版本采用操作；展开箭头改用 Harness 标准 Chevron 图标。
- 生图与视觉设置已使用 Harness 风格的底部操作栏：取消恢复最近保存快照，保存仅在配置变更且有效时启用，视觉模型测试入口保持独立可用。
- 生成包包含 Image Host 入口，且 package manifest 无未解析的 `workspace:`。
- 插件构建的 pnpm filter 已包含 workspace 依赖闭包，可在重建根依赖布局后完整物化 Client 类型检查所需依赖。
- Host、Client、Bundle 和 Go 内置插件版本已同步为 `0.1.33`；Windows `go test ./internal/plugin` 通过。
- 当前本机安装态仍运行旧 Harness commit `141eb6fef83422698aef7a981029e843e8161534` 和内置插件 `0.1.24`，不能用来验证针对新内核构建的 `0.1.33`；待另一进程完成新版 Desktop/Harness 安装态部署后再执行最终 smoke，未构建 NSIS。
