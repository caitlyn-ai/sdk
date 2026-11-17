package conformance

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"

	"github.com/caitlyn-ai/sdk/go"
	"github.com/caitlyn-ai/sdk/go/core"
)

// sentLog records the requests a client sends, before they reach the mock.
type sentLog struct {
	mu   sync.Mutex
	reqs []*http.Request
}

func (s *sentLog) Do(r *http.Request) (*http.Response, error) {
	s.mu.Lock()
	s.reqs = append(s.reqs, r)
	s.mu.Unlock()
	return http.DefaultClient.Do(r)
}

// ifMatchOperations reads the model: each operation with an If-Match header, and whether it is @ifMatchOptional.
func ifMatchOperations(t *testing.T) map[string]bool {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, "model", "model.json"))
	if err != nil {
		t.Fatal(err)
	}
	var model struct {
		Shapes map[string]struct {
			Type    string                     `json:"type"`
			Input   *struct{ Target string }   `json:"input"`
			Traits  map[string]json.RawMessage `json:"traits"`
			Members map[string]struct {
				Traits map[string]json.RawMessage `json:"traits"`
			} `json:"members"`
		} `json:"shapes"`
	}
	if err := json.Unmarshal(b, &model); err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for id, s := range model.Shapes {
		if s.Type != "operation" || s.Input == nil {
			continue
		}
		for _, m := range model.Shapes[s.Input.Target].Members {
			var header string
			json.Unmarshal(m.Traits["smithy.api#httpHeader"], &header)
			if header == "If-Match" {
				_, optional := s.Traits["ai.caitlyn.traits#ifMatchOptional"]
				out[id[len("ai.caitlyn.v3#"):]] = optional
			}
		}
	}
	return out
}

func init() {
	protocol["if-match.optional-set"] = func(t *testing.T, _ mock) {
		b, err := os.ReadFile(filepath.Join(root, "conformance", "cases", "examples.json"))
		if err != nil {
			t.Fatal(err)
		}
		var file struct {
			Cases []exampleCase `json:"cases"`
		}
		json.Unmarshal(b, &file)
		inputs := map[string]json.RawMessage{}
		for _, ex := range file.Cases {
			if _, ok := inputs[ex.Operation]; !ok {
				inputs[ex.Operation] = ex.Input
			}
		}
		ops := ifMatchOperations(t)
		names := make([]string, 0, len(ops))
		for op := range ops {
			names = append(names, op)
		}
		sort.Strings(names)
		for _, op := range names {
			optional := ops[op]
			call, ok := examples[op]
			raw, hasInput := inputs[op]
			if !ok || !hasInput {
				t.Fatalf("%s: no example to call it with", op)
			}
			// The example's input without its If-Match
			var in map[string]json.RawMessage
			json.Unmarshal(raw, &in)
			delete(in, "ifMatch")
			raw, _ = json.Marshal(in)
			m := fresh(t)
			sent := &sentLog{}
			_, err := call(t, client(t, m, caitlyn.WithHTTPClient(sent)), raw)
			var ie *core.InputError
			isInput := errors.As(err, &ie) && ie.Member == "If-Match"
			if optional {
				if isInput || len(sent.reqs) == 0 {
					t.Fatalf("%s is @ifMatchOptional: got %v with %d requests sent", op, err, len(sent.reqs))
				}
				for _, r := range sent.reqs {
					if r.Header.Get("If-Match") != "" {
						t.Fatalf("%s sent If-Match %q", op, r.Header.Get("If-Match"))
					}
				}
				continue
			}
			if !isInput || len(sent.reqs) != 0 {
				t.Fatalf("%s needs If-Match: got %v with %d requests sent, want an input error before anything is sent", op, err, len(sent.reqs))
			}
		}
	}
}
