package plugin

import "time"

type Action string

const (
	Install   Action = "install"
	Update    Action = "update"
	Uninstall Action = "uninstall"
)

type Phase string

const (
	Queued         Phase = "queued"
	Downloading    Phase = "downloading"
	Verifying      Phase = "verifying"
	Staging        Phase = "staging"
	Installing     Phase = "installing"
	Validating     Phase = "validating"
	ReadyToRestart Phase = "ready-to-restart"
	Restarting     Phase = "restarting"
	Completed      Phase = "completed"
	Failed         Phase = "failed"
	RolledBack     Phase = "rolled-back"
)

type Plugin struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	Publisher        string   `json:"publisher"`
	PackageName      string   `json:"packageName"`
	RepositoryURL    string   `json:"repositoryURL"`
	Version          string   `json:"version"`
	InstalledVersion *string  `json:"installedVersion"`
	UpdateAvailable  bool     `json:"updateAvailable"`
	Permissions      []string `json:"permissions"`
	License          string   `json:"license"`
}

type Snapshot struct {
	Plugins         []Plugin `json:"plugins"`
	CatalogVerified bool     `json:"catalogVerified"`
	GeneratedAt     string   `json:"generatedAt"`
	Warning         *string  `json:"warning"`
}

type MutationRequest struct {
	PluginID string `json:"pluginId"`
	Action   Action `json:"action"`
}

type Operation struct {
	ID       string  `json:"id"`
	PluginID string  `json:"pluginId"`
	Action   Action  `json:"action"`
	Phase    Phase   `json:"phase"`
	Progress int     `json:"progress"`
	Message  string  `json:"message"`
	Error    *string `json:"error"`
}

func (o Operation) terminal() bool {
	return o.Phase == Completed || o.Phase == Failed || o.Phase == RolledBack
}

type catalogDocument struct {
	SchemaVersion int             `json:"schemaVersion"`
	GeneratedAt   string          `json:"generatedAt"`
	Plugins       []catalogPlugin `json:"plugins"`
}

type catalogPlugin struct {
	SchemaVersion int    `json:"schemaVersion"`
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Publisher     string `json:"publisher"`
	PackageName   string `json:"packageName"`
	Repository    struct {
		URL string `json:"url"`
	} `json:"repository"`
	Release struct {
		Version  string `json:"version"`
		AssetURL string `json:"assetUrl"`
		SHA256   string `json:"sha256"`
	} `json:"release"`
	Permissions []string `json:"permissions"`
	License     string   `json:"license"`
}

type operationRecord struct {
	Operation
	createdAt time.Time
}
