package cmdutil

// Stability is the CLI's maturity, as a whole: "preview" while its commands, flags and output may still change,
// "stable" once they won't. It is the one place that says so: `caitlyn version` (and its --json, which the installers
// read after an install) and the root help take it from here, so dropping preview is this one line. It isn't a
// release channel: beta is only ever a channel (pre-release packages, caitlyn update --channel beta).
const Stability = "preview"

// StabilityNote is the sentence people read about it, or "" once the CLI is stable.
func StabilityNote() string {
	if Stability == "stable" {
		return ""
	}
	return "The Caitlyn CLI is in preview: its commands, flags and output may still change."
}
