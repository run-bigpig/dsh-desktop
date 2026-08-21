package desktopassets

import "embed"

// AppIcon is the rounded DSH-DeskTop application icon derived from the
// DeepSeek fish used by the startup interface.
//
//go:embed build/appicon.png
var AppIcon []byte

// Frontend contains the offline-only recovery interface.
//
//go:embed all:frontend
var Frontend embed.FS
