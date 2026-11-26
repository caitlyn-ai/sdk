// Package exitcode is the CLI's one exit-code table (the CLI design, 4.6). Every command uses it, every
// machine-readable error carries its code as exitCode, and `caitlyn help exit-codes` prints it.
package exitcode

// The exit codes. They never change meaning: scripts and AI agents branch on them.
const (
	OK = 0
	// Failed is any error not listed below, and a batch or sync in which some items failed.
	Failed = 1
	// Usage is a bad flag or argument; nothing was sent.
	Usage = 2
	// ActionNeeded: a plan has unresolved items, a confirmation was needed with no terminal, or --fail-on (or ai setup
	// --check) found changes.
	ActionNeeded = 3
	// Auth: not signed in, or the credential was refused.
	Auth = 4
	// Forbidden: not allowed (403, interactive-only operations, agent scopes, a read-only profile).
	Forbidden = 5
	// NotFound: 404, or an agent with no live version.
	NotFound = 6
	// Conflict: 409, 412 or 428, conflicting or stale.
	Conflict = 7
	// NotSupported: the workspace's release doesn't have this operation or member yet.
	NotSupported = 8
	// Timeout: --timeout, or a wait's time limit.
	Timeout = 9
	// Connection: Caitlyn couldn't be reached, or a stream was lost.
	Connection = 10
	// RateLimited: still rate limited after retries.
	RateLimited = 11
	// Interrupted: Ctrl-C.
	Interrupted = 130
)

// Entry is one row of the table.
type Entry struct {
	Code    int    `json:"code"`
	Meaning string `json:"meaning"`
	From    string `json:"from,omitempty"`
}

// Table is the exit-code table, in order.
var Table = []Entry{
	{OK, "Succeeded", ""},
	{Failed, "Failed: any error not listed below, and a batch or sync in which some items failed", "500, JOB_FAILED, INGESTION_BATCH_FAILED, other problems"},
	{Usage, "Usage error: bad flags or arguments, nothing sent", ""},
	{ActionNeeded, "Action needed: a plan has unresolved items, a confirmation was needed with no terminal, or --fail-on found changes", "INGESTION_BATCH_UNRESOLVED, AI_SETUP_OUT_OF_DATE, a declined or impossible prompt"},
	{Auth, "Not signed in, or the credential was refused", "401, sign_in_required, invalid_grant"},
	{Forbidden, "Not allowed", "403, interactive-only operations, agent scopes, a read-only profile"},
	{NotFound, "Not found", "404, a missing live version"},
	{Conflict, "Conflict or stale", "409, 412, 428"},
	{NotSupported, "Not supported by this workspace's release", "NotSupportedByServer, 404 UNKNOWN_OPERATION"},
	{Timeout, "Timed out", "WAIT_TIMEOUT, --timeout"},
	{Connection, "Could not reach Caitlyn, or the stream was lost", "CONNECTION_ERROR, STREAM_LOST"},
	{RateLimited, "Rate limited after retries", "429"},
	{Interrupted, "Interrupted (Ctrl-C)", ""},
}

// ForStatus maps an HTTP status to its exit code.
func ForStatus(status int) int {
	switch {
	case status == 401:
		return Auth
	case status == 403:
		return Forbidden
	case status == 404 || status == 410:
		return NotFound
	case status == 409 || status == 412 || status == 428:
		return Conflict
	case status == 429:
		return RateLimited
	case status == 408 || status == 504:
		return Timeout
	case status == 400 || status == 422:
		return Failed
	default:
		return Failed
	}
}

// ForCode maps an error code that decides the exit code by itself (whatever the status).
func ForCode(code string) (int, bool) {
	switch code {
	case "UNKNOWN_OPERATION":
		return NotSupported, true
	case "WAIT_TIMEOUT", "TIMEOUT":
		return Timeout, true
	case "CONNECTION_ERROR", "STREAM_LOST", "NO_FINAL_EVENT":
		return Connection, true
	case "INGESTION_BATCH_UNRESOLVED":
		return ActionNeeded, true
	case "NOT_AVAILABLE_TO_CREDENTIALS", "AUTH_API_SCOPE_DENIED":
		return Forbidden, true
	case "sign_in_required", "invalid_grant", "invalid_token", "UNAUTHENTICATED":
		return Auth, true
	}
	return 0, false
}
