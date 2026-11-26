// Command rasterise checks the emblem's SVGs against assets.lock.json, rasterises them to PNG, and records the
// PNGs' hashes in the lock file. Run it with `go generate ./assets` from cli/.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/caitlyn-ai/sdk/cli/assets"
	"github.com/caitlyn-ai/sdk/cli/assets/raster"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "rasterise:", err)
		os.Exit(1)
	}
}

func run() error {
	b, err := os.ReadFile("assets.lock.json")
	if err != nil {
		return err
	}
	var lock assets.Lock
	if err := json.Unmarshal(b, &lock); err != nil {
		return err
	}
	for i, f := range lock.Files {
		svg, err := os.ReadFile(f.Path)
		if err != nil {
			return err
		}
		if got := sum(svg); got != f.SHA256 {
			return fmt.Errorf("%s has SHA-256 %s, but the lock file pins %s: update the lock file deliberately if the emblem changed", f.Path, got, f.SHA256)
		}
		p, err := raster.PNG(svg, lock.Pixels)
		if err != nil {
			return fmt.Errorf("%s: %w", f.Path, err)
		}
		if err := os.WriteFile(f.PNG, p, 0o644); err != nil {
			return err
		}
		lock.Files[i].PNGSHA256 = sum(p)
	}
	out, err := json.MarshalIndent(lock, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile("assets.lock.json", append(out, '\n'), 0o644)
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
