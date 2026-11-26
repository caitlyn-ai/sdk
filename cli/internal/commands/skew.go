package commands

import (
	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/commands/gen"
	"github.com/caitlyn-ai/sdk/cli/internal/skew"
)

func init() {
	registrations = append(registrations, func() {
		gen.NoteServerVersion = func(f *cmdutil.Factory, v string) {
			cfg, err := f.Config()
			if err != nil {
				return
			}
			skew.Save(cfg.Dir(), cfg.Profile(), v, f.Now())
		}
	})
}
