package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/buildinfo"
	"github.com/run-bigpig/dsh-desktop/internal/state"
)

const maxReleaseResponse = 2 << 20

var sha256Pattern = regexp.MustCompile(`(?i)\b[0-9a-f]{64}\b`)

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type Manager struct {
	paths          appconfig.Paths
	store          *state.Store
	currentVersion string
	releaseAPI     string
	client         httpDoer
}

type githubRelease struct {
	TagName string        `json:"tag_name"`
	HTMLURL string        `json:"html_url"`
	Body    string        `json:"body"`
	Draft   bool          `json:"draft"`
	Assets  []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Digest             string `json:"digest"`
	Size               int64  `json:"size"`
}

func New(paths appconfig.Paths, store *state.Store, currentVersion, releaseAPI string, client httpDoer) *Manager {
	if client == nil {
		client = http.DefaultClient
	}
	return &Manager{paths: paths, store: store, currentVersion: currentVersion, releaseAPI: releaseAPI, client: client}
}

func (m *Manager) Check(ctx context.Context) (*state.DesktopUpdate, error) {
	m.set(state.Checking, "正在检查桌面应用更新")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, m.releaseAPI, nil)
	if err != nil {
		return nil, m.fail(err)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "StarWeave/"+m.currentVersion)
	response, err := m.client.Do(request)
	if err != nil {
		return nil, m.fail(fmt.Errorf("check desktop release: %w", err))
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, m.fail(fmt.Errorf("desktop release service returned HTTP %d", response.StatusCode))
	}
	var release githubRelease
	if err := json.NewDecoder(io.LimitReader(response.Body, maxReleaseResponse)).Decode(&release); err != nil {
		return nil, m.fail(fmt.Errorf("decode desktop release: %w", err))
	}
	if release.Draft {
		return nil, m.fail(fmt.Errorf("latest desktop release is still a draft"))
	}
	version := strings.TrimPrefix(strings.TrimSpace(release.TagName), "v")
	newer, err := newerVersion(version, m.currentVersion)
	if err != nil {
		return nil, m.fail(fmt.Errorf("invalid desktop release version %q: %w", release.TagName, err))
	}
	if !newer {
		m.store.SetAvailableUpdate(nil)
		m.set(state.Ready, "StarWeave "+m.currentVersion+" 已是最新版本")
		return nil, nil
	}
	assetName, err := platformAssetName()
	if err != nil {
		return nil, m.fail(err)
	}
	asset, ok := findAsset(release.Assets, assetName)
	if !ok {
		return nil, m.fail(fmt.Errorf("release %s does not contain %s", release.TagName, assetName))
	}
	checksum, err := m.resolveChecksum(ctx, release.Assets, asset)
	if err != nil {
		return nil, m.fail(err)
	}
	update := &state.DesktopUpdate{Version: version, Tag: release.TagName, ReleaseURL: release.HTMLURL, ReleaseNotes: release.Body, AssetName: asset.Name, DownloadURL: asset.BrowserDownloadURL, SHA256: checksum, Size: asset.Size}
	m.store.SetAvailableUpdate(update)
	m.set(state.Idle, "发现桌面应用新版本 "+version+"，可下载完整安装包升级")
	return update, nil
}

func (m *Manager) Download(ctx context.Context) (string, error) {
	update := m.store.Snapshot().AvailableUpdate
	if update == nil {
		return "", fmt.Errorf("no desktop update is available; check for updates first")
	}
	m.set(state.Downloading, "正在下载桌面应用 "+update.Version)
	dir := filepath.Join(m.paths.Updates, "v"+update.Version)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", m.fail(err)
	}
	target := filepath.Join(dir, update.AssetName)
	partial := target + ".part"
	_ = os.Remove(partial)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, update.DownloadURL, nil)
	if err != nil {
		return "", m.fail(err)
	}
	request.Header.Set("User-Agent", "StarWeave/"+m.currentVersion)
	response, err := m.client.Do(request)
	if err != nil {
		return "", m.fail(fmt.Errorf("download desktop update: %w", err))
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", m.fail(fmt.Errorf("desktop update download returned HTTP %d", response.StatusCode))
	}
	file, err := os.OpenFile(partial, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", m.fail(err)
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), response.Body)
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(partial)
		return "", m.fail(copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(partial)
		return "", m.fail(closeErr)
	}
	if update.Size > 0 && written != update.Size {
		_ = os.Remove(partial)
		return "", m.fail(fmt.Errorf("desktop update size mismatch: expected %d, got %d", update.Size, written))
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, update.SHA256) {
		_ = os.Remove(partial)
		return "", m.fail(fmt.Errorf("desktop update SHA-256 mismatch"))
	}
	_ = os.Remove(target)
	if err := os.Rename(partial, target); err != nil {
		_ = os.Remove(partial)
		return "", m.fail(err)
	}
	m.set(state.Installing, "安装包校验完成，正在准备升级并重启")
	return target, nil
}

func (m *Manager) DownloadAndLaunch(ctx context.Context) error {
	installer, err := m.Download(ctx)
	if err != nil {
		return err
	}
	if err := StartApplyHelper(installer, m.paths.Logs); err != nil {
		return m.fail(fmt.Errorf("start desktop update helper: %w", err))
	}
	return nil
}

func (m *Manager) resolveChecksum(ctx context.Context, assets []githubAsset, asset githubAsset) (string, error) {
	if strings.HasPrefix(strings.ToLower(asset.Digest), "sha256:") {
		value := strings.TrimSpace(asset.Digest[len("sha256:"):])
		if sha256Pattern.MatchString(value) && len(value) == 64 {
			return strings.ToLower(value), nil
		}
	}
	checksumAsset, ok := findAsset(assets, asset.Name+".sha256")
	if !ok {
		return "", fmt.Errorf("release %s is missing its SHA-256 digest", asset.Name)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, checksumAsset.BrowserDownloadURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "StarWeave/"+m.currentVersion)
	response, err := m.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("download release checksum: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("release checksum returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	if err != nil {
		return "", err
	}
	match := sha256Pattern.FindString(string(body))
	if match == "" {
		return "", fmt.Errorf("release checksum is invalid")
	}
	return strings.ToLower(match), nil
}

func (m *Manager) set(phase state.Phase, message string) {
	m.store.SetRuntimeInfo(phase, message, m.store.Snapshot().HarnessURL)
}

func (m *Manager) fail(err error) error {
	m.set(state.Failed, err.Error())
	return err
}

func platformAssetName() (string, error) {
	if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
		return buildinfo.WindowsX64Asset, nil
	}
	return "", fmt.Errorf("desktop self-update is not yet supported on %s/%s", runtime.GOOS, runtime.GOARCH)
}

func findAsset(assets []githubAsset, name string) (githubAsset, bool) {
	for _, asset := range assets {
		if asset.Name == name && asset.BrowserDownloadURL != "" {
			return asset, true
		}
	}
	return githubAsset{}, false
}

type semVersion struct {
	major, minor, patch int
	pre                 string
}

func newerVersion(candidate, current string) (bool, error) {
	a, err := parseVersion(candidate)
	if err != nil {
		return false, err
	}
	b, err := parseVersion(strings.TrimPrefix(current, "v"))
	if err != nil {
		return false, err
	}
	for _, pair := range [][2]int{{a.major, b.major}, {a.minor, b.minor}, {a.patch, b.patch}} {
		if pair[0] != pair[1] {
			return pair[0] > pair[1], nil
		}
	}
	if a.pre == b.pre {
		return false, nil
	}
	if a.pre == "" {
		return true, nil
	}
	if b.pre == "" {
		return false, nil
	}
	return comparePrerelease(a.pre, b.pre) > 0, nil
}

func parseVersion(value string) (semVersion, error) {
	core, pre, _ := strings.Cut(strings.SplitN(value, "+", 2)[0], "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return semVersion{}, fmt.Errorf("version must use major.minor.patch")
	}
	numbers := make([]int, 3)
	for i, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return semVersion{}, fmt.Errorf("invalid numeric component %q", part)
		}
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return semVersion{}, fmt.Errorf("invalid numeric component %q", part)
		}
		numbers[i] = n
	}
	return semVersion{major: numbers[0], minor: numbers[1], patch: numbers[2], pre: pre}, nil
}

func comparePrerelease(a, b string) int {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(left) && i < len(right); i++ {
		if left[i] == right[i] {
			continue
		}
		ln, le := strconv.Atoi(left[i])
		rn, re := strconv.Atoi(right[i])
		switch {
		case le == nil && re == nil:
			if ln < rn {
				return -1
			}
			return 1
		case le == nil:
			return -1
		case re == nil:
			return 1
		case left[i] < right[i]:
			return -1
		default:
			return 1
		}
	}
	if len(left) < len(right) {
		return -1
	}
	if len(left) > len(right) {
		return 1
	}
	return 0
}
