<p align="center">
  <img src="frontend/starweave-logo.png" width="112" alt="StarWeave logo">
</p>

<h1 align="center">StarWeave</h1>

<p align="center">
  面向 Windows 的 DeepSeek Harness 独立桌面运行环境
</p>

StarWeave 是一个基于 Wails 3 的桌面壳，用于安装、启动和管理官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 应用。它负责桌面窗口、固定版本运行时、进程树、托盘、插件管理、日志、恢复和应用更新；会话、模型、工具、设置及主要界面仍由 Harness 本身提供。

StarWeave 不 fork、复制或修改 Harness 作为本项目的应用源码，也不创建第二套聊天界面。Harness 启动并通过安全检查后，WebView 会直接顶层导航到官方 loopback 页面。

> 当前生产支持范围为 **Windows 10 22H2 或更高版本（x64）**。macOS 和 Linux 尚未完成发布验证。

## 核心能力

- **官方 Harness Web 界面**：直接加载固定提交构建出的官方 Web profile，不使用 iframe 或平行渲染器。
- **独立运行环境**：安装包提供锁定的 Node 和完整 pnpm 运行时；安装及 Harness 启动不依赖系统 Node、npm、npx、pnpm 或 Git。
- **严格的本地访问边界**：Harness 只监听 `127.0.0.1` 的随机端口；StarWeave 校验就绪 URL 和 `window.__DSH_BOOT__` 后才显示主界面。
- **桌面生命周期管理**：支持单实例、启动过渡、托盘驻留、Harness 重启、日志访问、优雅关闭和完整进程树清理。
- **可恢复的版本切换**：桌面发行版携带固定 Harness 版本；切换前备份 `harness-home`，新版本启动失败时自动恢复上一版本。
- **事务式插件管理**：插件安装、更新和卸载先在隔离 profile 中完成，验证成功后再激活；启动失败会恢复原 profile。
- **手动桌面更新**：仅在用户主动检查时读取 GitHub Release，下载完整 NSIS 安装包，校验 SHA-256 后执行覆盖安装。
- **内置桌面集成**：通过 Harness 正式插件扩展点提供插件市场、右侧会话工作台、文件与 Git 操作、MCP、文档与视觉能力、图像工作台、图表展示、ThinkingData 配置和界面外观。

## 安装

### 系统要求

- Windows 10 22H2 或更高版本，x64 架构；
- Microsoft Edge WebView2 Evergreen Runtime；
- 安装期间可访问 npm 官方源或 npmmirror，以部署 Harness 锁文件声明的依赖。

### 安装步骤

1. 从 [GitHub Releases](https://github.com/run-bigpig/dsh-desktop/releases) 下载 `StarWeaveInstaller.exe` 和同名 `.sha256` 文件。
2. 可选：使用 PowerShell 校验安装包哈希，并与 sidecar 文件中的值比较：

   ```powershell
   (Get-FileHash .\StarWeaveInstaller.exe -Algorithm SHA256).Hash.ToLower()
   ```

3. 运行安装器，选择安装目录和本次安装使用的依赖源：
   - `https://registry.npmjs.org/`，默认；
   - `https://registry.npmmirror.com/`，失败时回退到官方源。
4. 从开始菜单启动 StarWeave。默认安装目录为：

   ```text
   %LOCALAPPDATA%\Programs\StarWeave
   ```

依赖源选择只对本次安装生效，不会修改全局 `.npmrc`、pnpm 配置或用户的命令行环境。依赖部署完成后，首次启动和日常启动均使用安装包内的固定 Harness 运行时；Marketplace、外部模型/API 和手动更新等联网功能仍按各自配置访问网络。

## 日常使用

StarWeave 启动时先显示桌面自有的过渡界面，后台拉起 Harness。严格就绪检查通过并完成短暂保持后，窗口切换到 Harness Web 界面。

关闭主窗口默认隐藏到系统托盘，不会退出 Harness。托盘菜单提供：

| 操作 | 说明 |
| --- | --- |
| 显示 | 恢复并聚焦主窗口 |
| 终端 | 在默认工作目录打开使用内置工具链的 `dsh` 终端 |
| 更新 | 手动检查 StarWeave 桌面版本更新 |
| 重启 | 停止并重新启动 Harness |
| 日志 | 打开应用日志目录 |
| 退出 | 关闭 StarWeave 及其管理的 Harness 进程树 |

第三方插件通过 Harness 设置中的 StarWeave Marketplace 管理。目录签名表示目录内容来自配置的发布源，不代表对插件质量或行为的审核；安装器还会校验不可变 GitHub Release 资产的 SHA-256。Marketplace 安装默认禁用第三方生命周期脚本。

会话工作台中的 Git 面板是可选能力，调用用户系统中的 Git；未安装系统 Git 时，该面板会显示为不可用，但不影响 StarWeave 安装、Harness 启动和其他功能。

## 架构边界

```text
StarWeave.exe (Wails 3)
├─ 启动、恢复和桌面更新界面
├─ Harness 运行时、插件、备份与进程管理
├─ WebView ───────────────> http://127.0.0.1:<随机端口>
├─ 认证的本地桌面能力桥接
└─ 内置 Node 子进程
   └─ dsh CLI --profile web --no-open --host 127.0.0.1 --port 0
```

| 层级 | 负责内容 |
| --- | --- |
| StarWeave | 安装布局、窗口与托盘、固定工具链、运行时激活、进程树、插件事务、备份、日志和桌面自更新 |
| Harness | Web UI、Host/Client 协议、profile、会话、模型、工具、设置、凭据和插件生命周期 |
| 操作系统 | WebView2、窗口系统、文件系统、进程与平台信任能力 |

Harness 始终固定到完整 commit SHA。它随新的 StarWeave 桌面发行版升级，不会在应用启动时动态解析 `master`，也不会在用户机器上拉取源码或执行 Harness 构建。

## 当前版本基线

以下值来自仓库当前的发布配置：

| 组件 | 版本 |
| --- | --- |
| StarWeave | `0.2.10` |
| Wails | `v3.0.0-beta.9` |
| DeepSeek Harness | `dsh-v0.1.2-rc.1` / `a66e4702047846cdaa10c66c9d3df3951f5ea70d` |
| Node.js | `24.12.0` |
| pnpm | `11.7.0` |
| 内置桌面插件 | `0.1.94` |

权威锁定信息位于 [release/seed.lock.json](release/seed.lock.json) 和 [release/toolchain.lock.json](release/toolchain.lock.json)。Harness 或工具链升级必须同步相关 seed 锁文件，并重新完成官方构建、插件构建和 Windows 运行验证。

## 数据与卸载

StarWeave 的默认私有数据目录为：

```text
%APPDATA%\StarWeave
├─ backups/                 Harness 数据备份
├─ harness-home/            持久化的 DSH_HOME
├─ logs/                    桌面、安装和清理日志
├─ marketplace/             插件目录、下载缓存、事务与备份
├─ plugin/                  内置插件发布数据
├─ pnpm-store/              跨安装和插件事务复用的 pnpm store
├─ state/                   当前版本、配置和 WebView2 数据
├─ toolchain/               缓存的内置 Node/pnpm 工具链
├─ updates/                 桌面更新下载
├─ versions/                按完整 commit 保存的 Harness 运行时
└─ workspaces/              默认工作目录
```

可以通过 `DSH_DESKTOP_DATA_DIR` 为开发或测试指定其他数据根目录。正式卸载只移除程序文件，默认保留 `%APPDATA%\StarWeave` 中的私有数据、pnpm store 和备份，避免不可恢复的数据丢失。

旧版本可能遗留 `repository.git/`。当前运行和发布流程不依赖它，也不会在升级时擅自删除现有用户数据。

## 开发

### 环境要求

- Go `1.25.x`；
- Wails CLI `v3.0.0-beta.9`；
- Task `v3`；
- Windows 发布构建额外需要 NSIS；
- 构建固定 Harness seed 时需要网络访问锁文件中的官方资源，以及 `starweave-ui-design` 的最新稳定 GitHub Release。

仓库从 WSL 编辑，但发布相关的 Go 测试、EXE 构建和安装验证必须在 Windows PowerShell 中执行。Linux 本机构建 Wails 窗口还需要 `pkg-config` 和 WebKitGTK 开发包，但 Linux 构建结果目前不属于生产支持范围。

### 常用检查

运行平台无关的 Go 测试：

```bash
task test
```

或直接运行当前测试集合：

```bash
go test ./internal/appconfig ./internal/state ./internal/runtime ./internal/update ./internal/selfupdate ./internal/logging ./internal/backup ./internal/seed
```

Windows 发布相关改动还应通过 Windows PowerShell 覆盖相应包测试，并按改动范围构建 host、client 和 bundle 三个内置插件包。插件源代码位于 [plugin/packages](plugin/packages)，其构建入口为 [plugin/scripts/build-against-harness.mjs](plugin/scripts/build-against-harness.mjs)。该入口必须通过 `--design-web` 接收已经校验并解压的 StarWeave UI Release 目录。

`task seed:windows` 会解析 `run-bigpig/starweave-ui-design` 的最新稳定 `vX.Y.Z` Release，校验 `starweave-ui-dist.tar.gz.sha256`，再将 Web UI 嵌入 plugin-host。实际 Tag、提交和归档哈希会记录在 seed 构建清单中；应用运行时不会动态下载 UI。

如果 `starweave-ui-design` 是私有仓库，本地构建环境需要提供 `STARWEAVE_UI_GITHUB_TOKEN`，GitHub Actions 仓库则需要配置同名 Secret；该凭据只需拥有目标仓库的只读 Contents 权限。公开仓库无需 Token。

### 仓库结构

```text
cmd/dsh-desktop/       桌面应用入口
frontend/              启动、过渡、恢复和更新界面静态资源
internal/              桌面生命周期、运行时、插件、更新、状态与备份
plugin/packages/       内置 host、client 和 bundle 插件源码
plugin/catalog/        随仓库维护的已签名插件目录
release/               Harness、工具链和伴随程序锁文件
scripts/               Windows seed、EXE 和安装包构建脚本
build/windows/         Windows 清单、图标与 NSIS 安装器源码
.github/workflows/     Windows 构建与 Release 发布流程
```

`dist/windows/` 是生成的构建缓存和发布暂存目录，不是源码。不要从旧 stage 或已安装程序反向覆盖仓库源文件。

## Windows 构建与发布

以下任务只能在 Windows 环境运行：

```powershell
# 构建并验证固定 Harness seed
task seed:windows

# 构建带版本信息的 Windows GUI 可执行文件
task build:windows

# 仅打包当前已通过指纹验证的 stage
task package:windows

# 顺序执行 seed、桌面 EXE 和 NSIS 打包
task release:windows
```

`task package:windows` 不会重建 Harness；当 seed、桌面输入或安装器输入发生变化时，它会要求先重新生成 stage。完整发布输出为：

```text
dist/windows/StarWeaveInstaller.exe
dist/windows/StarWeaveInstaller.exe.sha256
```

发布流程会校验锁定下载、执行 Harness 官方 `pnpm install --frozen-lockfile` 与 `pnpm run build:official`、针对精确提交构建内置插件、执行启动冒烟检查，并确认发行内容不包含 PortableGit、npm/npx 或完整 Harness `node_modules`。

GitHub Actions 的 [Windows Package](.github/workflows/windows-package.yml) 工作流支持手动构建；推送 `v*` 标签时会将安装器和 SHA-256 sidecar 发布到对应 GitHub Release。

## 相关项目与说明

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：StarWeave 加载的官方 Harness 项目。
- [内置桌面插件说明](plugin/README.md)：host、client 和 bundle 三个包的构建关系。
- [第三方许可声明](plugin/THIRD_PARTY_NOTICES.md)：内置插件分发涉及的第三方许可信息。
