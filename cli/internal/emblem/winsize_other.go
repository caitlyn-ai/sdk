//go:build !unix

package emblem

// winSize: no pixel fields off Unix; the cell size comes from the terminal's replies, if any.
func winSize() (cols, rows, xpix, ypix int, ok bool) { return 0, 0, 0, 0, false }
