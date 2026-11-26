// Command caitlyn is the Caitlyn CLI: https://build.caitlyn.ai/cli/
package main

import (
	"os"

	"github.com/caitlyn-ai/sdk/cli/internal/commands"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/root"
)

func main() {
	commands.Register()
	os.Exit(root.Main(os.Args[1:]))
}
