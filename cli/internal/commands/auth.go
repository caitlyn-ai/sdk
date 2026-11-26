package commands

import (
	"github.com/caitlyn-ai/sdk/cli/internal/auth"
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
	"github.com/caitlyn-ai/sdk/cli/internal/emblem"
)

// Sign-in: the provider every command's clients sign in through, and the auth commands (the CLI design, section 5).
func init() {
	registrations = append(registrations, func() {
		root.NewAuth = func() cmdutil.AuthProvider { return auth.NewProvider() }
		root.AddCommands = append(root.AddCommands, auth.AddCommands)
		emblem.Identity = auth.WelcomeIdentity
	})
}
