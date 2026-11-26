//go:build unix

package emblem

import (
	"os"

	"golang.org/x/sys/unix"
)

// winSize reads TIOCGWINSZ on stdout, whose pixel fields give the cell size with no query (19.2).
func winSize() (cols, rows, xpix, ypix int, ok bool) {
	ws, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0, 0, 0, 0, false
	}
	return int(ws.Col), int(ws.Row), int(ws.Xpixel), int(ws.Ypixel), true
}
