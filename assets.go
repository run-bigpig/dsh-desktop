package desktopassets

import "embed"

// Frontend contains the offline-only recovery interface.
//
//go:embed all:frontend
var Frontend embed.FS
