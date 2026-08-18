package update

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type packageJSON struct {
	PackageManager string `json:"packageManager"`
	Engines        struct {
		Node string `json:"node"`
	} `json:"engines"`
}

var exactPNPM = regexp.MustCompile(`^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$`)

func ValidateToolchain(packagePath, nodeVersion, pnpmVersion string) error {
	b, err := os.ReadFile(packagePath)
	if err != nil {
		return err
	}
	var p packageJSON
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	m := exactPNPM.FindStringSubmatch(p.PackageManager)
	if len(m) != 2 {
		return fmt.Errorf("packageManager must pin an exact pnpm version")
	}
	if strings.TrimPrefix(pnpmVersion, "v") != m[1] {
		return fmt.Errorf("Harness requires pnpm %s, embedded toolchain is %s", m[1], pnpmVersion)
	}
	major, minor, err := parseMajorMinor(nodeVersion)
	if err != nil {
		return err
	}
	if !nodeRangeAllows(p.Engines.Node, major, minor) {
		return fmt.Errorf("embedded Node %s does not satisfy Harness engines.node %q", nodeVersion, p.Engines.Node)
	}
	return nil
}

func parseMajorMinor(v string) (int, int, error) {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".")
	if len(parts) < 2 {
		return 0, 0, fmt.Errorf("invalid version %q", v)
	}
	major, e1 := strconv.Atoi(parts[0])
	minor, e2 := strconv.Atoi(parts[1])
	if e1 != nil || e2 != nil {
		return 0, 0, fmt.Errorf("invalid version %q", v)
	}
	return major, minor, nil
}
func nodeRangeAllows(r string, major, minor int) bool {
	for _, branch := range strings.Split(r, "||") {
		branch = strings.TrimSpace(branch)
		if strings.HasPrefix(branch, ">=") {
			m, n, err := parseMajorMinor(strings.TrimPrefix(branch, ">="))
			if err == nil && (major > m || major == m && minor >= n) {
				return true
			}
		}
		if strings.HasPrefix(branch, "^") {
			m, n, err := parseMajorMinor(strings.TrimPrefix(branch, "^"))
			if err == nil && major == m && minor >= n {
				return true
			}
		}
	}
	return false
}
