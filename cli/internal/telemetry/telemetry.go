// Package telemetry is "usage data for Caitlyn", the CLI's anonymous product telemetry (the CLI design, 9.1),
// sent to Caitlyn. It is not "your own traces" (package traces, OpenTelemetry to your own collector): neither reads
// the other's settings. One small event per command run,
// holding only the fields in Event, queued locally and sent in the background by a detached `caitlyn telemetry
// flush`, so it never slows a command. It is opt-in on every channel, stable and beta alike: off until the person
// turns it on (caitlyn telemetry on, or CAITLYN_TELEMETRY=1), and it does nothing at all until the build has an
// endpoint (17.3).
package telemetry

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// Endpoint is where events are sent. Empty until the telemetry endpoint exists: with no endpoint nothing is queued
// or sent. The release build sets it with
//
//	-ldflags "-X github.com/caitlyn-ai/sdk/cli/internal/telemetry.Endpoint=https://telemetry.caitlyn.ai/cli"
//
// CAITLYN_TELEMETRY_ENDPOINT overrides it (tests, and checking a new endpoint).
var Endpoint = ""

// EndpointEnv overrides Endpoint.
const EndpointEnv = "CAITLYN_TELEMETRY_ENDPOINT"

// DocsURL is the telemetry page: every field, an example payload, the switches and the retention.
const DocsURL = "https://build.caitlyn.ai/cli/telemetry"

// Notice is printed once on stderr, before the first interactive run's output (9.1). Telemetry is off until the
// person turns it on, so the notice asks; it never says anything is being collected.
const Notice = `Usage data for Caitlyn. Help improve the Caitlyn CLI by sending Caitlyn anonymous usage
data: which commands and flags run, how long they take and whether they succeed. Never
arguments, IDs, content or anything about you or your workspace. It's off unless you
turn it on: caitlyn telemetry on
More: ` + DocsURL + "\n"

// Event is everything sent about one run, and nothing else. Its fields are the list in 9.1; a test fails if one is
// added without the list changing.
type Event struct {
	// EventID de-duplicates retries.
	EventID string `json:"event_id"`
	// Time is when the run ended, rounded down to the hour, in UTC.
	Time string `json:"time"`
	// InstallID is a random UUID made on first use, unrelated to the machine, the person or the workspace.
	InstallID string `json:"install_id"`
	// Command is the command path from the CLI's own tree ("kb sync"), never an argument.
	Command string `json:"command"`
	// Flags are the names of the flags used, from the command tree; never their values. An unknown flag is "unknown".
	Flags []string `json:"flags"`
	// ExitCode is the run's exit code.
	ExitCode int `json:"exit_code"`
	// DurationMS is how long the run took, rounded to 10 ms.
	DurationMS int64 `json:"duration_ms"`
	// Version and Channel are the CLI's.
	Version string `json:"version"`
	Channel string `json:"channel"`
	// OS and Arch are Go's names (darwin, arm64).
	OS   string `json:"os"`
	Arch string `json:"arch"`
	// CI is whether the run was in CI, and CIProvider which (gitlab, github, …).
	CI         bool   `json:"ci"`
	CIProvider string `json:"ci_provider,omitempty"`
	// Agent is whether an AI agent ran it, and AgentName which (claude-code, …).
	Agent     bool   `json:"agent"`
	AgentName string `json:"agent_name,omitempty"`
	// TTY says whether stdin, stdout and stderr were terminals.
	TTY [3]bool `json:"tty"`
}

// Fields is the payload's field list (9.1), in order.
var Fields = []string{"event_id", "time", "install_id", "command", "flags", "exit_code", "duration_ms", "version", "channel", "os", "arch", "ci", "ci_provider", "agent", "agent_name", "tty"}

// RoundDuration rounds a run's duration to 10 ms, in milliseconds.
func RoundDuration(d time.Duration) int64 { return d.Round(10 * time.Millisecond).Milliseconds() }

// RoundTime rounds a time down to the hour, in UTC (RFC 3339).
func RoundTime(t time.Time) string { return t.UTC().Truncate(time.Hour).Format(time.RFC3339) }

// NewUUID is a random UUID version 4.
func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// Inputs are what the switches read.
type Inputs struct {
	Lookup func(string) (string, bool)
	// UserSetting is the telemetry setting from the user file ("" when it isn't set there).
	UserSetting string
	// CI is whether CI was detected.
	CI bool
	// Endpoint is the endpoint in use ("" when the build has none).
	Endpoint string
}

// Decision is whether telemetry is on, and the rule that decided it.
type Decision struct {
	On bool
	// Rule is 1 to 5 (9.1's order), and Reason says it in words.
	Rule   int
	Reason string
	// Explicit is true when the person turned it on with CAITLYN_TELEMETRY: no first-run notice is needed.
	Explicit bool
	// NoEndpoint: on, but the build has no endpoint, so nothing is collected.
	NoEndpoint bool
}

// Collects reports whether events are queued: on, with an endpoint.
func (d Decision) Collects() bool { return d.On && !d.NoEndpoint }

func truthy(v string) (val, ok bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "on", "yes":
		return true, true
	case "0", "false", "off", "no":
		return false, true
	}
	return false, false
}

// Decide applies the switches in 9.1's order; the first that matches decides:
//
//  1. CAITLYN_TELEMETRY=0 (or off) turns it off; CAITLYN_TELEMETRY=1 (or on) turns it on;
//  2. DO_NOT_TRACK set and not 0: off;
//  3. telemetry = false in the user file (caitlyn telemetry off): off;
//  4. CI: off (a pipeline's owners turn it on with CAITLYN_TELEMETRY=1, not a user file a runner happens to have);
//  5. telemetry = true in the user file (caitlyn telemetry on): on;
//  6. otherwise off: it is opt-in, on every channel, stable and beta alike.
func Decide(in Inputs) Decision {
	d := decide(in)
	if d.On && in.Endpoint == "" {
		d.NoEndpoint = true
	}
	return d
}

func decide(in Inputs) Decision {
	if v, ok := in.Lookup("CAITLYN_TELEMETRY"); ok {
		if on, known := truthy(v); known {
			if on {
				return Decision{On: true, Rule: 1, Reason: "CAITLYN_TELEMETRY=" + v, Explicit: true}
			}
			return Decision{Rule: 1, Reason: "CAITLYN_TELEMETRY=" + v}
		}
	}
	if v, ok := in.Lookup("DO_NOT_TRACK"); ok && strings.TrimSpace(v) != "" && strings.TrimSpace(v) != "0" {
		return Decision{Rule: 2, Reason: "DO_NOT_TRACK is set"}
	}
	on, known := truthy(in.UserSetting)
	if known && !on {
		return Decision{Rule: 3, Reason: "telemetry = false in your user file"}
	}
	if in.CI {
		return Decision{Rule: 4, Reason: "CI was detected (CAITLYN_TELEMETRY=1 turns it on for a pipeline)"}
	}
	if known && on {
		return Decision{On: true, Rule: 5, Reason: "telemetry = true in your user file (caitlyn telemetry on)", Explicit: true}
	}
	return Decision{Rule: 6, Reason: "the default: it's off until you turn it on (caitlyn telemetry on)"}
}

// String describes the decision for `caitlyn telemetry status`.
func (d Decision) String() string {
	state := "off"
	if d.On {
		state = "on"
	}
	s := fmt.Sprintf("Usage data for Caitlyn is %s: %s.", state, d.Reason)
	if d.NoEndpoint {
		s += " This build has no usage-data endpoint, so nothing is collected or sent."
	}
	return s
}
