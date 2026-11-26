// Package raster turns the emblem's SVG into a PNG with a pure-Go rasteriser (oksvg and rasterx), so the build needs
// no browser or native library and gives the same bytes on every machine.
package raster

import (
	"bytes"
	"fmt"
	"image"
	"image/png"

	"github.com/srwiley/oksvg"
	"github.com/srwiley/rasterx"
)

// PNG rasterises svg to a square PNG px pixels on a side, on a transparent background.
func PNG(svg []byte, px int) ([]byte, error) {
	icon, err := oksvg.ReadIconStream(bytes.NewReader(svg), oksvg.StrictErrorMode)
	if err != nil {
		return nil, fmt.Errorf("reading the SVG: %w", err)
	}
	icon.SetTarget(0, 0, float64(px), float64(px))
	img := image.NewNRGBA(image.Rect(0, 0, px, px))
	scanner := rasterx.NewScannerGV(px, px, img, img.Bounds())
	icon.Draw(rasterx.NewDasher(px, px, scanner), 1)
	var b bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&b, img); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
