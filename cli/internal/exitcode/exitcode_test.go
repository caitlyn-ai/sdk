package exitcode

import "testing"

func TestStatusesAndCodes(t *testing.T) {
	for status, want := range map[int]int{401: Auth, 403: Forbidden, 404: NotFound, 409: Conflict, 412: Conflict, 428: Conflict, 429: RateLimited, 500: Failed, 400: Failed} {
		if got := ForStatus(status); got != want {
			t.Errorf("ForStatus(%d) = %d, want %d", status, got, want)
		}
	}
	for code, want := range map[string]int{"UNKNOWN_OPERATION": NotSupported, "WAIT_TIMEOUT": Timeout, "CONNECTION_ERROR": Connection, "STREAM_LOST": Connection, "INGESTION_BATCH_UNRESOLVED": ActionNeeded, "NOT_AVAILABLE_TO_CREDENTIALS": Forbidden} {
		if got, ok := ForCode(code); !ok || got != want {
			t.Errorf("ForCode(%s) = %d, want %d", code, got, want)
		}
	}
	seen := map[int]bool{}
	for _, e := range Table {
		if seen[e.Code] {
			t.Errorf("code %d twice in the table", e.Code)
		}
		seen[e.Code] = true
	}
}
