# 设计会话

## 用户流程

- 在 Harness 新会话页或会话模式切换器中选择“设计模式”。
- 首条消息发送前保持 Harness 原生空白会话界面，不挂载画布或占位区域。
- 首条消息发送后自动进入左右布局并创建空白设计：左侧为 OpenPencil 设计编辑器，右侧保留 Harness 原生聊天记录和 Agent 输入框；原生“对话”Tab 在该会话中显示为“设计”。
- 空白设计创建完成后，当前会话的 OpenPencil MCP 即可操作画布。
- 新建、打开和另存为 `.fig` 始终由用户在画布工具栏中触发。文件导出状态单独显示，替换文档前会提示这也将替换会话快照。
- 画布每次修改都会原子保存为当前 Harness 会话的内部快照；重启应用并重新进入同一会话时自动恢复。

## 隔离和权限

每个 Harness 会话维护独立的内存文档和随机浏览器连接令牌。Agent 级 MCP 连接由 Host 绑定到 `agent.session.id`，工具调用会强制使用该会话当前打开的文档。另一个会话未连接画布时不能复用当前文档。

Agent 不注册 `open_file`、`new_document`、`save_file` 或 `eval`。OpenPencil 的其他官方工具通过 Harness 原生 Agent MCP 客户端执行，因此保留工具策略、取消和结果投影。设计 preset 将随插件安装的 OpenPencil 官方 Skill 目录显式配置给 Harness；执行画布设计任务时，Agent 会先加载该 Skill，再调用自动创建的当前文档。

内部快照存放在 Harness 会话持久化服务为该 sessionId 分配的目录中，不使用工作区路径。历史会话即使不在 `ctx.sessions` 中，也通过公开的 `sessionPersistence.inspect` 和 `locate` 定位。连接恢复失败时拒绝 Agent 修改并禁止用空白快照覆盖旧数据。手动编辑使用短延迟合并保存，离开会话前刷新待保存修改；Agent 修改等待 Host 原子写入确认才返回成功。该快照仅用于会话恢复；用户仍通过“保存”选择位置并写入可移植的 `.fig` 文件。

## 源码和构建

设计 UI 源码位于 `plugin/packages/plugin-design-ui`，与 `plugin-host`、`plugin-client` 和 `plugin-bundle` 一同版本化。编辑器壳使用 OpenPencil 公开的 `provideEditor`、`useCanvas`、`PageListRoot`、`LayerTreeRoot` 和 `ToolbarRoot` API。画布使用官方 `useCanvas` 的单个 canvas，同时渲染场景与选择覆盖层；输入、文字编辑和拖入文件分别由 `useCanvasInput`、`useTextEdit`、`useCanvasDrop` 接管。每个会话使用独立的 `Editor`、`SceneGraph` 和官方应用同样的 `shallowReactive` 状态，视口尺寸取实际 renderer。不得额外添加一个承接输入的空白 canvas。`plugin/scripts/build-against-harness.mjs` 针对锁定的 Harness commit 执行类型检查和 Vite 构建，并将 JavaScript、CSS、CanvasKit WASM 与 OpenPencil 自带字体放入 `plugin-host/web/starweave-design`。

内置插件四个 package 的版本必须一致，并与 Go 的 `desktopPluginVersion` 同步。发布门禁包括 Design UI 类型检查和构建、Host/Client/Bundle 编译、设计会话隔离测试、Windows Go 测试、完整 seed 流程与已安装状态 smoke。

## 官方能力接入范围

对照 OpenPencil `v0.14.0` 官方源码及同版本公开 npm API，当前提供：

- 官方 11 种绘图工具、分组工具选单及 Lucide 图标映射，活动工具同步显示。
- 页面新建、切换、重命名、删除；图层树展开、选择、拖动、重命名、显隐和锁定。
- 撤销/重做、复制粘贴、删除、微移、缩放；分组、画板、组件、布尔运算等官方命令菜单。快捷键只绑定编辑器 DOM，不拦截 Harness 输入框或属性文本输入。
- 位置、尺寸、角度、对齐、外观、填充、渐变、描边、文字、约束、自动布局、效果和组件属性面板。
- 本地变量集合、模式、变量的编辑和颜色绑定/解绑；共享样式创建、重命名、更新、删除、应用与解绑。样式使用官方内部节点和属性引用，更新传播到全部绑定图层，删除保留图层当前外观。
- 图片填充选择/替换、预览、FILL/FIT/CROP/TILE 四种缩放模式，图片字节通过官方 `storeImage` 保存。
- 矢量路径进入/退出、锚点选择/拖动/删除/断开、贝塞尔手柄调整、路径内撤销/重做。官方画布输入通过插件适配方法操作同一个 Editor；旋转、嵌套与翻转坐标沿用官方矩阵转换。
- 官方 IORegistry 的文件读写和页面/选区导出，Worker 以 Blob 在宿主同源启动。

Agent 使用官方注册器生成的全部非 eval 工具 schema，并补充会话限定的 `undo`、`redo`、`shared_style`，共 109 个工具。`set_image_fill` 沿用官方 image_data/scale_mode 参数。修改后的选区、页面、视口同步到用户正在看的编辑器。创建对象自动选中并聚焦；批量操作失败回滚，历史覆盖整个文档（包括页面、变量和组件索引）。PDF 返回 MCP resource，位图返回 image。

官方 Skill 来自 `open-pencil/skills` 的 `623927958f277b0d8810a2582a38ae24409f7577`，保留原文。StarWeave 会话限定、禁用 CLI/文件生命周期、工具选择和验证规则写在 Host 的设计模式提示中，工具参数以安装版本的 MCP schema 为准。

矢量编辑所需的应用层方法按 OpenPencil v0.14.0 的 `src/app/editor/vector-edit` 适配在插件内，来源与 MIT 许可证随源码和构建产物保留。适配差异包括每个完成手势写回文档、切页/Agent 操作前提交、会话保存纳入未退出的路径编辑，以及端点合并索引修正。使用公开核心 API 和官方输入组件，不新增画布渲染器。

Windows 中文字体由 Wails 在 Harness 导航完成后注入只读加载入口，复用桌面网关按需读取系统 `Fonts/simhei.ttf`。字体接口使用独立凭据、精确 Harness origin 校验及 CORS；不暴露文件路径，不开放通用 Wails bindings，也不将系统字体打入插件或会话文件。设计插件通过 OpenPencil `markLoaded` / `setCJKFallbackFamily` 注册中文回退，保留文档原有 Inter 等字体声明，供画布、文字编辑和导出共用。首次挂载先加载字体，迟到的导航注入会触发重绘；页面刷新及应用重启后重新注入。系统缺少黑体或读取失败时保留官方字体加载流程并报告字体错误。

仍未覆盖官方应用所有工作流，例如已有路径的端点续画、路径编辑的全部右键操作、原生本地字体权限界面、协作与云端功能。此处列出的是已接入且经过验证的编辑能力，不代表官方全量功能对等。

## 本地验证

设计回归覆盖会话隔离、快照恢复与写入确认、恢复失败保护、工具注册与目标限定、Agent 图形/变量修改、整文档撤销重做、批量回滚、响应式状态及编辑器快捷键隔离。

Windows Edge 浏览器实测覆盖 Harness 新设计会话、Agent 创建并填充矩形、图层和属性同步、桌面重启后恢复；另验证手动绘制、属性修改、撤销重做、页面与变量操作、颜色变量绑定/解绑、PNG/SVG/PDF 导出，以及快速切换和浏览器刷新后的修改恢复。完整 seed、安装器和干净机器验证仍是发布前门禁，本次本地插件和 EXE smoke 不替代这些门禁。

新增能力的浏览器回归脚本位于 `packages/plugin-design-ui/scripts/browser-smoke.cjs`，参数为构建后的设计资源目录、Playwright 模块路径、ws 模块路径、浏览器 EXE 路径和截图输出目录。它建立隔离的 loopback WebSocket 会话及内存快照存储，覆盖真实图片上传、样式 RPC、锚点鼠标交互、跨会话隔离及 .fig 解码恢复，不接触用户运行中的会话。

中文字体原生验证：在 Windows 编译并运行 `go build -tags production -ldflags "-H windowsgui" -o dist/windows/design-font-wails.exe ./internal/plugin/testdata/design-font-wails`，给上述浏览器脚本追加第六个参数 `http://127.0.0.1:9229`。独立测试窗口沿用生产版的 Wails 启动页→外部 loopback 导航和字体注入，使用临时 WebView profile。验证 Inter 字体声明下的中文实际绘制、不同汉字的像素差异及新页面恢复后的字形一致性；官方 .fig 导入存在 1 像素基线取整，因此字形比较只允许上下移动 1 像素，要求 alpha 覆盖完全相同。仅测试窗口启用 CDP，生产桌面不启用；测试结束关闭该窗口。

StarWeave 的新会话模式菜单通过 Harness 插槽优先级复用官方组件和选择控制器，仅展示标准模式与设计模式，旧 preset 及其会话仍可由 Host 恢复。首次安装写入 `ui-theme.preference: dark`，已有主题选择保持不变。设计界面及文件对话框使用 StarWeave 品牌；OpenPencil 官方 Skill、依赖标识和来源许可证保持原样。

工作台替换官方 `details` 插槽，与会话区同层并排，沿用原生打开、关闭和会话生命周期。工作台挂载期间扩展 details 列宽，默认偏好 800px，至少保留 400px 会话空间；窄窗口仍由 Harness 自动收起 details。拖动或方向键调整宽度，双击或 Home 恢复默认值。关闭工作台后清除局部布局样式，恢复原生详情区域，不改变文件树默认宽度。
