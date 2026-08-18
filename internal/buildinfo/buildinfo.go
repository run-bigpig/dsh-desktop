package buildinfo

// Version and ReleaseAPIURL may be replaced by release builds through -ldflags -X.
var (
	Version       = "0.2.1"
	ReleaseAPIURL = "https://api.github.com/repos/deepseek-ai/deepseek-harness-desktop/releases/latest"
)

const WindowsX64Asset = "DeepSeek-Harness-Desktop-Setup-x64.exe"
