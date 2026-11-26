// Package cli holds the files the Caitlyn CLI embeds from this directory: the naming overlay (naming.yaml).
// The command itself is cmd/caitlyn.
package cli

import _ "embed"

// NamingOverlay is naming.yaml: the CLI's own naming choices, which the model does not carry (the CLI design, 11.2).
//
//go:embed naming.yaml
var NamingOverlay []byte
