package core

import (
	"runtime/debug"
	"testing"
)

func TestModuleVersion(t *testing.T) {
	const path = "github.com/caitlyn-ai/caitlyn-go"
	dep := func(m debug.Module) *debug.BuildInfo {
		return &debug.BuildInfo{Main: debug.Module{Path: "example.com/app", Version: "(devel)"}, Deps: []*debug.Module{&m}}
	}
	cases := []struct {
		name string
		info *debug.BuildInfo
		want string
	}{
		{"a dependency installed from a tag", dep(debug.Module{Path: path, Version: "v0.1.1"}), "0.1.1"},
		{"a pseudo-version from an untagged commit", dep(debug.Module{Path: path, Version: "v0.1.2-0.20261113010203-abcdef123456"}), "0.1.2-0.20261113010203-abcdef123456"},
		{"a module in a subdirectory, tagged go/v0.2.0", dep(debug.Module{Path: "github.com/caitlyn-ai/sdk/go", Version: "v0.2.0"}), "0.0.0"},
		{"replaced by another version", dep(debug.Module{Path: path, Version: "v0.1.0", Replace: &debug.Module{Path: "example.com/fork", Version: "v0.1.5"}}), "0.1.5"},
		{"replaced by a local directory", dep(debug.Module{Path: path, Version: "v0.0.1", Replace: &debug.Module{Path: "../go"}}), "0.0.0"},
		{"the main module, tagged", &debug.BuildInfo{Main: debug.Module{Path: path, Version: "v0.3.0"}}, "0.3.0"},
		{"the main module, from a working tree", &debug.BuildInfo{Main: debug.Module{Path: path, Version: "(devel)"}}, "0.0.0"},
		{"not in the build", dep(debug.Module{Path: "example.com/other", Version: "v1.0.0"}), "0.0.0"},
	}
	for _, c := range cases {
		if got := moduleVersion(c.info, path, "0.0.0"); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	// The subdirectory module is found by its own path.
	if got := moduleVersion(dep(debug.Module{Path: "github.com/caitlyn-ai/sdk/go", Version: "v0.2.0"}), "github.com/caitlyn-ai/sdk/go", "0.0.0"); got != "0.2.0" {
		t.Errorf("subdirectory module: got %q", got)
	}
}
