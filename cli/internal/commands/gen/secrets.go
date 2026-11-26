package gen

import (
	"encoding/json"

	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

// secretsIn lists the values of @sensitive members in a response (a webhook trigger's signing secret, a new
// client secret), following the operation's output shape, so they can be cleared for printing first (15.2).
// The model marks no member @sensitive yet, so this finds nothing today; TestSecretLookingMembersAreSensitive fails
// when a secret-named member arrives unmarked. auth token's bearer token goes through the same guard regardless.
func secretsIn(m *spec.Manifest, op *spec.Operation, body []byte) []string {
	var v any
	if json.Unmarshal(body, &v) != nil {
		return nil
	}
	var out []string
	if p := op.Payload(); p != nil {
		walkSecrets(m, p.Type, v, &out, 0)
		return out
	}
	obj, _ := v.(map[string]any)
	for _, mem := range op.Output {
		if mem.Location != "body" {
			continue
		}
		val, ok := obj[mem.Wire]
		if !ok {
			continue
		}
		if mem.Sensitive {
			collect(val, &out)
			continue
		}
		walkSecrets(m, mem.Type, val, &out, 0)
	}
	return out
}

func walkSecrets(m *spec.Manifest, t *spec.Type, v any, out *[]string, depth int) {
	if t == nil || v == nil || depth > 12 {
		return
	}
	switch t.Type {
	case "ref":
		sh := m.Shapes[t.Ref]
		obj, ok := v.(map[string]any)
		if sh == nil || !ok {
			return
		}
		for _, mem := range sh.Members {
			val, ok := obj[mem.Wire]
			if !ok {
				continue
			}
			if mem.Sensitive {
				collect(val, out)
				continue
			}
			walkSecrets(m, mem.Type, val, out, depth+1)
		}
	case "list":
		if l, ok := v.([]any); ok {
			for _, it := range l {
				walkSecrets(m, t.Member, it, out, depth+1)
			}
		}
	case "map":
		if mp, ok := v.(map[string]any); ok {
			for _, it := range mp {
				walkSecrets(m, t.Value, it, out, depth+1)
			}
		}
	}
}

func collect(v any, out *[]string) {
	switch t := v.(type) {
	case string:
		if t != "" {
			*out = append(*out, t)
		}
	case nil:
	default:
		b, _ := json.Marshal(t)
		*out = append(*out, string(b))
	}
}
