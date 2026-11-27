//go:build unix

package e2e

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// stopsWholeGroup starts cmd in a process group of its own and makes cancelling its context kill the whole group: a
// shell's pipeline, not only the shell, so the output pipe the test reads closes.
func stopsWholeGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone // it had exited already
		}
		return err
	}
}
