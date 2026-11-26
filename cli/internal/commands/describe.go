package commands

import "github.com/caitlyn-ai/sdk/cli/internal/commands/describe"

// The CLI describing itself, for AI agents and the docs: commands, help (as text, JSON and Markdown, and the AGENTS.md
// section and skill), docs and mcp add.
func init() { registrations = append(registrations, describe.Register) }
