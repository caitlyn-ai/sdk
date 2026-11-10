package core

import (
	"bytes"
	"encoding/json"
)

// Raw keeps the JSON object a value was read from, unknown fields included (PROTOCOL.md 4.1). Generated
// structures hold one in an unexported field and expose it through Raw() and RawJSON().
type Raw struct {
	b []byte
}

// NewRaw copies b, which may belong to a decoder buffer.
func NewRaw(b []byte) Raw {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || b[0] != '{' {
		return Raw{}
	}
	return Raw{b: bytes.Clone(b)}
}

// Map decodes the object afresh on each call (callers may modify the result), or returns nil.
func (r Raw) Map() map[string]any {
	if r.b == nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(r.b, &m) != nil {
		return nil
	}
	return m
}

// JSON returns the object's bytes as received, or nil.
func (r Raw) JSON() json.RawMessage { return json.RawMessage(bytes.Clone(r.b)) }
