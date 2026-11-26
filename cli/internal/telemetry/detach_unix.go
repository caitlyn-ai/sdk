//go:build !windows

package telemetry

import (
	"os/exec"
	"syscall"
)

// detach puts the flush in its own process group, so it outlives the command and a Ctrl-C to the terminal.
func detach(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
