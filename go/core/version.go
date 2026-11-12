package core

import (
	"runtime/debug"
	"strings"
)

// ModuleVersion is the version of the Go module at modulePath that this program was built with, without its
// leading "v", or fallback when the build does not say.
//
// Go installs a module from a git tag, so the source carries no released version: the generated SDKVersion is the
// repository's 0.0.0 placeholder. The tag's version is in the binary's build information, as the main module's
// version or as one of its dependencies. A module replaced by a local directory, or built from a working tree
// ("(devel)"), has no version of its own there, so it gets fallback.
//
// It reads the module path from generated code, so it works whatever the path is (github.com/caitlyn-ai/caitlyn-go,
// or a module in a subdirectory such as github.com/caitlyn-ai/sdk/go, whose tags are go/vX.Y.Z: the build
// information has the version without the prefix).
func ModuleVersion(modulePath, fallback string) string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return fallback
	}
	return moduleVersion(info, modulePath, fallback)
}

func moduleVersion(info *debug.BuildInfo, modulePath, fallback string) string {
	mod := &info.Main
	if mod.Path != modulePath {
		mod = nil
		for _, d := range info.Deps {
			if d.Path == modulePath {
				mod = d
				break
			}
		}
	}
	if mod == nil {
		return fallback
	}
	version := mod.Version
	if mod.Replace != nil {
		version = mod.Replace.Version // "" when replaced by a local directory
	}
	if version == "" || version == "(devel)" {
		return fallback
	}
	return strings.TrimPrefix(version, "v")
}
