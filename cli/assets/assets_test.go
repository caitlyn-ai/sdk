package assets

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/png"
	"os"
	"testing"

	"github.com/caitlyn-ai/sdk/cli/assets/raster"
)

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// The committed sources and PNGs match the lock file, so a changed emblem fails the build until the lock is updated.
func TestAssetsMatchLock(t *testing.T) {
	lock, err := ReadLock()
	if err != nil {
		t.Fatal(err)
	}
	if len(lock.Files) != 2 {
		t.Fatalf("lock lists %d files, want 2", len(lock.Files))
	}
	embedded := map[string][]byte{"caitlyn-face-white.svg": SVGWhite, "caitlyn-face-black.svg": SVGBlack, "emblem-white.png": EmblemWhite, "emblem-black.png": EmblemBlack}
	for _, f := range lock.Files {
		disk, err := os.ReadFile(f.Path)
		if err != nil {
			t.Fatal(err)
		}
		if got := sum(disk); got != f.SHA256 {
			t.Errorf("%s: SHA-256 %s, lock pins %s", f.Path, got, f.SHA256)
		}
		if !bytes.Equal(disk, embedded[f.Path]) {
			t.Errorf("%s: the embedded copy differs from the file", f.Path)
		}
		if got := sum(embedded[f.PNG]); got != f.PNGSHA256 {
			t.Errorf("%s: SHA-256 %s, lock records %s: run go generate ./assets", f.PNG, got, f.PNGSHA256)
		}
	}
	if total := len(EmblemWhite) + len(EmblemBlack); total > 100_000 {
		t.Errorf("embedded PNGs are %d bytes, over the 100 KB budget", total)
	}
}

// The committed PNGs are exactly what the rasteriser makes from the pinned SVGs: nobody edited them by hand.
func TestPNGsRegenerate(t *testing.T) {
	lock, _ := ReadLock()
	for _, c := range []struct {
		svg, png []byte
		name     string
		want     [3]uint8
	}{{SVGWhite, EmblemWhite, "white", [3]uint8{0xff, 0xff, 0xff}}, {SVGBlack, EmblemBlack, "black", [3]uint8{0x0c, 0x0d, 0x0d}}} {
		p, err := raster.PNG(c.svg, lock.Pixels)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(p, c.png) && !samePicture(t, p, c.png) {
			t.Errorf("%s: the committed PNG differs from a fresh rasterisation: run go generate ./assets", c.name)
		}
		img, err := png.Decode(bytes.NewReader(c.png))
		if err != nil {
			t.Fatal(err)
		}
		if b := img.Bounds(); b.Dx() != lock.Pixels || b.Dy() != lock.Pixels {
			t.Errorf("%s: %v, want %d square", c.name, b, lock.Pixels)
		}
		checkInk(t, c.name, img, c.want)
	}
}

// checkInk: the emblem has ink (opaque pixels) in its SVG's fill colour and a transparent corner.
func checkInk(t *testing.T, name string, img image.Image, want [3]uint8) {
	t.Helper()
	b := img.Bounds()
	opaque := 0
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, a := img.At(x, y).RGBA()
			if a < 0xff00 {
				continue
			}
			opaque++
			if got := [3]uint8{uint8(r >> 8), uint8(g >> 8), uint8(bl >> 8)}; got != want {
				t.Fatalf("%s: opaque pixel at %d,%d is %d,%d,%d", name, x, y, r>>8, g>>8, bl>>8)
			}
		}
	}
	if opaque < b.Dx()*b.Dy()/10 {
		t.Errorf("%s: only %d opaque pixels", name, opaque)
	}
	if _, _, _, a := img.At(0, 0).RGBA(); a != 0 {
		t.Errorf("%s: the corner isn't transparent", name)
	}
}

// samePicture compares two renderings pixel by pixel, allowing each channel to differ by a little: the rasteriser's
// floating point is fused differently on arm64 and amd64, so an edge pixel's coverage can round one step apart. A
// hand edit changes far more than that.
func samePicture(t *testing.T, a, b []byte) bool {
	t.Helper()
	ia, err := png.Decode(bytes.NewReader(a))
	if err != nil {
		return false
	}
	ib, err := png.Decode(bytes.NewReader(b))
	if err != nil || ia.Bounds() != ib.Bounds() {
		return false
	}
	off := 0
	for y := ia.Bounds().Min.Y; y < ia.Bounds().Max.Y; y++ {
		for x := ia.Bounds().Min.X; x < ia.Bounds().Max.X; x++ {
			r1, g1, b1, a1 := ia.At(x, y).RGBA()
			r2, g2, b2, a2 := ib.At(x, y).RGBA()
			for _, d := range []int{int(r1) - int(r2), int(g1) - int(g2), int(b1) - int(b2), int(a1) - int(a2)} {
				if d < 0 {
					d = -d
				}
				if d > 3*257 {
					off++
				}
			}
		}
	}
	return off == 0
}
