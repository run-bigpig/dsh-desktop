package state

import "time"

type Phase string

const (
	Idle        Phase = "idle"
	Starting    Phase = "starting"
	Ready       Phase = "ready"
	Checking    Phase = "checking"
	Building    Phase = "building"
	Downloading Phase = "downloading"
	Installing  Phase = "installing"
	Pending     Phase = "pending"
	Activating  Phase = "activating"
	Recovering  Phase = "recovering"
	Failed      Phase = "failed"
)

type RuntimeRef struct {
	Commit      string    `json:"commit"`
	ActivatedAt time.Time `json:"activatedAt,omitempty"`
	ReadyAt     time.Time `json:"readyAt,omitempty"`
}

type ActiveState struct {
	Current  RuntimeRef  `json:"current"`
	Previous *RuntimeRef `json:"previous,omitempty"`
}

type PendingState struct {
	RuntimeRef
	Remote            string    `json:"remote"`
	Ref               string    `json:"ref"`
	SignatureVerified bool      `json:"signatureVerified"`
	BuiltAt           time.Time `json:"builtAt"`
}

type DesktopUpdate struct {
	Version      string `json:"version"`
	Tag          string `json:"tag"`
	ReleaseURL   string `json:"releaseUrl"`
	ReleaseNotes string `json:"releaseNotes,omitempty"`
	AssetName    string `json:"assetName"`
	DownloadURL  string `json:"downloadUrl"`
	SHA256       string `json:"sha256"`
	Size         int64  `json:"size"`
}

type Snapshot struct {
	Phase             Phase          `json:"phase"`
	Message           string         `json:"message"`
	Active            *ActiveState   `json:"active,omitempty"`
	Pending           *PendingState  `json:"pending,omitempty"`
	DesktopVersion    string         `json:"desktopVersion"`
	AvailableUpdate   *DesktopUpdate `json:"availableUpdate,omitempty"`
	HarnessURL        string         `json:"harnessUrl,omitempty"`
	LogsDirectory     string         `json:"logsDirectory"`
	DataDirectory     string         `json:"dataDirectory"`
	DeveloperMode     bool           `json:"developerMode"`
	UnverifiedUpdates bool           `json:"unverifiedUpdates"`
	UpdatedAt         time.Time      `json:"updatedAt"`
}
