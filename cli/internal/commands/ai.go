package commands

import (
	"github.com/caitlyn-ai/sdk/cli/internal/auth"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/aisetup"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
)

// Setting up AI coding tools: caitlyn ai setup, status and remove, and sign-in's offer to run setup.
func init() {
	registrations = append(registrations, func() {
		root.AddCommands = append(root.AddCommands, aisetup.Add)
		auth.AfterSignIn = aisetup.OfferAfterSignIn
	})
}
