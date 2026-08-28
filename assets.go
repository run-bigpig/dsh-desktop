package desktopassets

import "embed"

// AppIcon is the StarWeave application icon used by the desktop window and tray.
//
//go:embed build/appicon.png
var AppIcon []byte

// Frontend contains the offline-only recovery interface.
//
//go:embed all:frontend
var Frontend embed.FS
