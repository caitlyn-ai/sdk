// Package assets holds the files the CLI embeds: the Caitlyn character emblem (the CLI design, 19.3), as the two
// source SVGs from the Caitlyn Design System's asset store, pinned by blob id and SHA-256 in assets.lock.json, and
// the PNGs rasterised from them.
//
// The PNGs are generated and committed; after the lock file changes, regenerate them:
//
//	go generate ./assets
package assets

import (
	_ "embed"
	"encoding/json"
)

//go:generate go run ./internal/rasterise

// EmblemWhite is the white emblem, for dark backgrounds.
//
//go:embed emblem-white.png
var EmblemWhite []byte

// EmblemBlack is the black emblem, for light backgrounds.
//
//go:embed emblem-black.png
var EmblemBlack []byte

// SVGWhite and SVGBlack are the sources.
var (
	//go:embed caitlyn-face-white.svg
	SVGWhite []byte
	//go:embed caitlyn-face-black.svg
	SVGBlack []byte
)

//go:embed assets.lock.json
var lockJSON []byte

// Lock is assets.lock.json.
type Lock struct {
	Comment string `json:"comment"`
	// Source is the design system's asset store: the artifact, its asset group and the version the blobs were
	// taken from.
	Source struct {
		Store   string `json:"store"`
		Group   string `json:"group"`
		Version int    `json:"version"`
	} `json:"source"`
	// Pixels is the PNGs' height (and width: the emblem is square): 6 rows of a 20-pixel cell, twice over for
	// high-density screens (19.2).
	Pixels int        `json:"pixels"`
	Files  []LockFile `json:"files"`
}

// LockFile is one pinned source and the PNG made from it.
type LockFile struct {
	Path string `json:"path"`
	// Blob is the asset's id in the store; From its name there.
	Blob      string `json:"blob"`
	From      string `json:"from"`
	SHA256    string `json:"sha256"`
	PNG       string `json:"png"`
	PNGSHA256 string `json:"pngSha256"`
}

// ReadLock parses the embedded lock file.
func ReadLock() (*Lock, error) {
	var l Lock
	if err := json.Unmarshal(lockJSON, &l); err != nil {
		return nil, err
	}
	return &l, nil
}
