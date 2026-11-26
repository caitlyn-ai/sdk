package emblem

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"strings"

	"golang.org/x/image/draw"
)

// Rows is the emblem's height on every screen (19, decided).
const Rows = 6

// HeadlineRows is the headline group: the headline and its detail line, centred on the emblem.
const HeadlineRows = 2

// FallbackCellAspect is the cell height ÷ width assumed for the text column when Kitty or iTerm2 can show the
// emblem but the cell size can't be measured. Those terminals keep the image's aspect ratio themselves (only the
// height is sent), so only the text column needs a guess; 2.5 is taller than common cells (about 2), so the text
// clears the emblem rather than overlapping it.
const FallbackCellAspect = 2.5

// ChunkSize is the most base64 a Kitty graphics escape carries.
const ChunkSize = 4096

// KittySeq is the Kitty graphics sequence: transmit and show a PNG (f=100) directly (t=d), with only its height in
// rows (r) so the terminal works out the width from the image's aspect ratio and its real cell size, the cursor left
// where it was (C=1) and no reply (q=2). The base64 goes in chunks of at most ChunkSize bytes.
func KittySeq(pngData []byte, rows int) string {
	b64 := base64.StdEncoding.EncodeToString(pngData)
	var b strings.Builder
	for i := 0; i < len(b64); i += ChunkSize {
		chunk := b64[i:min(len(b64), i+ChunkSize)]
		more := 0
		if i+ChunkSize < len(b64) {
			more = 1
		}
		if i == 0 {
			fmt.Fprintf(&b, "\x1b_Ga=T,f=100,t=d,r=%d,C=1,q=2,m=%d;%s\x1b\\", rows, more, chunk)
		} else {
			fmt.Fprintf(&b, "\x1b_Gm=%d;%s\x1b\\", more, chunk)
		}
	}
	return b.String()
}

// ITerm2Seq is iTerm2's inline image: the height in rows and no width, with the aspect ratio preserved.
func ITerm2Seq(pngData []byte, rows int) string {
	return fmt.Sprintf("\x1b]1337;File=inline=1;height=%d;preserveAspectRatio=1:%s\a", rows, base64.StdEncoding.EncodeToString(pngData))
}

// SixelSeq converts the PNG to Sixel at px×px pixels: the size worked out from the measured cell. The emblem is one
// colour on transparency, so the conversion is exact: a pixel is ink when it is at least half opaque, and pixels
// without ink are left as the terminal's background (P2=1).
func SixelSeq(pngData []byte, px int) (string, error) {
	src, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		return "", err
	}
	dst := image.NewNRGBA(image.Rect(0, 0, px, px))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)
	ink := inkColour(src)
	var b strings.Builder
	pct := func(v uint8) int { return (int(v)*100 + 127) / 255 }
	fmt.Fprintf(&b, "\x1bP0;1;0q\"1;1;%d;%d#0;2;%d;%d;%d", px, px, pct(ink.R), pct(ink.G), pct(ink.B))
	for top := 0; top < px; top += 6 {
		b.WriteString("#0")
		run, last := 0, byte(0)
		flush := func() {
			switch {
			case run == 0:
			case run > 3:
				fmt.Fprintf(&b, "!%d%c", run, last)
			default:
				b.WriteString(strings.Repeat(string(last), run))
			}
		}
		for x := 0; x < px; x++ {
			bits := byte(0)
			for dy := 0; dy < 6 && top+dy < px; dy++ {
				if dst.NRGBAAt(x, top+dy).A >= 128 {
					bits |= 1 << dy
				}
			}
			c := 63 + bits
			if c == last && run > 0 {
				run++
				continue
			}
			flush()
			last, run = c, 1
		}
		flush()
		b.WriteString("-")
	}
	b.WriteString("\x1b\\")
	return b.String(), nil
}

// inkColour is the emblem's colour: its most opaque pixel's.
func inkColour(img image.Image) color.NRGBA {
	var best color.NRGBA
	bnd := img.Bounds()
	for y := bnd.Min.Y; y < bnd.Max.Y; y++ {
		for x := bnd.Min.X; x < bnd.Max.X; x++ {
			c := color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
			if c.A > best.A {
				best = c
				if c.A == 0xff {
					return best
				}
			}
		}
	}
	return best
}

// TextColumn is the column the text starts at, beside an emblem widthPx wide: the emblem's width in cells, rounded
// up, and two blank columns of clear space (19.2).
func TextColumn(widthPx, cellW int) int {
	return (widthPx+cellW-1)/cellW + 2
}

// Column is the text column for the support found: from the measured cell, or from FallbackCellAspect.
func (s Support) Column() int {
	if s.CellW > 0 && s.CellH > 0 {
		h := Rows * s.CellH
		return TextColumn(h, s.CellW) // the emblem is square
	}
	aspect := FallbackCellAspect
	return int(math.Ceil(float64(Rows)*aspect)) + 2
}

// Compose lays the emblem beside its text (the alignment rule, 19.2): the space is reserved first so drawing near
// the bottom of the screen scrolls before the image is placed; the image is drawn at the top-left with the cursor
// saved and restored around it; the headline group (the first HeadlineRows lines) sits on the emblem's middle rows,
// starting floor((Rows − HeadlineRows) ÷ 2) rows down; the rest flows below in the same column, as far as it needs,
// blank lines kept. Text is placed with cursor-forward, so nothing is written over the image.
func Compose(image string, col int, lines []string) string {
	top := (Rows - HeadlineRows) / 2
	height := max(Rows, top+len(lines))
	var b strings.Builder
	if height > 1 {
		b.WriteString(strings.Repeat("\n", height-1))
		fmt.Fprintf(&b, "\x1b[%dA", height-1)
	}
	b.WriteString("\r\x1b7")
	b.WriteString(image)
	b.WriteString("\x1b8")
	for r := 0; r < height; r++ {
		if i := r - top; i >= 0 && i < len(lines) && lines[i] != "" {
			fmt.Fprintf(&b, "\x1b[%dC%s", col, lines[i])
		}
		b.WriteString("\n")
	}
	return b.String()
}
