# DeepSeek Harness Desktop

独立的 Wails 3 桌面运行时管理器。它不 fork、不复制、不修改 DeepSeek Harness 源码；桌面壳只负责管理官方 `dsh --profile web` 子进程，并在严格验证 loopback 页面后让 WebView 顶层导航到官方 Harness Web 界面。

## 当前实现

- Wails `v3.0.0-beta.9`、Go 1.25，Windows x64 为首发平台。
- 安装包只携带运行所需的固定 Node 和指定 Harness commit 的已构建 seed runtime；pnpm 与 PortableGit 仅用于发布机构建，不分发给普通用户。
- 首次启动离线运行；不读取系统 Node。
- Harness 运行时目录以完整 commit SHA 命名且发布后不再原地更新。
- 就绪门禁要求精确的 `dsh web: http://127.0.0.1:<port>`，并验证首页含 `window.__DSH_BOOT__`。
- POSIX 使用独立进程组，Windows 使用 `KILL_ON_JOB_CLOSE` Job Object。
- 关闭窗口隐藏到托盘；支持单实例恢复、打开内置 `dsh` 终端、重启、桌面版本更新检查、日志和退出。
- 更新检查读取桌面应用的 GitHub Release；下载完整 NSIS 安装包并校验 SHA-256 后，由隐藏升级助手等待旧进程退出、静默覆盖安装并自动重启。
- Harness 版本随桌面发行包升级，不在用户机器上 fetch 源码、安装依赖或执行构建；切换内置 runtime 前备份 `harness-home`，新版本未就绪会自动恢复旧代码选择和旧数据。
- 恢复页是纯离线静态资源；Harness 页面不导入恢复页的 Wails bindings。

桌面更新源固定为 `https://api.github.com/repos/deepseek-ai/deepseek-harness-desktop/releases/latest`。Windows x64 Release 必须同时发布 `DeepSeek-Harness-Desktop-Setup-x64.exe` 和对应的 `.sha256` 文件；如果 GitHub API 已提供资产 digest，也会直接使用该 SHA-256。

## 开发验证

```bash
go test ./internal/appconfig ./internal/state ./internal/runtime ./internal/update ./internal/selfupdate ./internal/logging ./internal/backup ./internal/seed
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go test -exec=true ./...
```

Linux 本机构建 Wails 窗口需要系统的 `pkg-config` 与 WebKitGTK 开发包。Windows 交叉编译不依赖这些 Linux GUI 包。

## Windows 发布

在 Windows x64 发布机安装 Go 1.25、Wails CLI、Task 和 NSIS，然后运行：

```powershell
task package:windows
```

发布流程读取 [toolchain.lock.json](release/toolchain.lock.json) 和 [seed.lock.json](release/seed.lock.json)，下载后先校验 SHA-256，再构建并冒烟验证 seed。输出安装器及同名 `.sha256` 文件。安装器为每用户 NSIS，并在安装前检测 Evergreen WebView2。

大型工具链、Harness checkout、`node_modules` 和 seed runtime 只存在于 `dist/` 发布暂存区，不进入本仓库。

## 私有数据布局

应用在用户配置目录下创建：

```text
toolchain/       versions/       harness-home/    backups/
logs/            updates/        state/           locks/
workspaces/
```

旧版本创建的 `repository.git/` 与 `pnpm-store/` 不再参与更新流程；为避免擅自删除用户数据，升级时不会自动移除。

卸载器只删除程序文件，默认保留私有数据与备份，避免不可恢复的数据丢失。
