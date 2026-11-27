//go:build !unix

package e2e

import "os/exec"

// stopsWholeGroup leaves cmd as it is: cancelling its context kills the process (the examples run under sh, a Unix
// shell).
func stopsWholeGroup(cmd *exec.Cmd) {}
