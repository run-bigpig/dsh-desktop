package seed

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed seed.lock.json
var manifestBytes []byte

type Manifest struct {
	SchemaVersion     int    `json:"schemaVersion"`
	Repository        string `json:"repository"`
	Commit            string `json:"commit"`
	Ref               string `json:"ref"`
	CLIEntry          string `json:"cliEntry"`
	Node              string `json:"node"`
	PNPM              string `json:"pnpm"`
	SignatureVerified bool   `json:"signatureVerified"`
}

func Load() (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(manifestBytes, &m); err != nil {
		return m, err
	}
	if len(m.Commit) != 40 || m.CLIEntry == "" {
		return m, fmt.Errorf("invalid embedded seed manifest")
	}
	return m, nil
}
