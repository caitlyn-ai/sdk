package describe

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

// Schema is a JSON Schema (2020-12) document, built from the manifest's shapes.
type Schema map[string]any

const schemaDialect = "https://json-schema.org/draft/2020-12/schema"

// InputSchema is the JSON Schema of an operation's input as `--from-file` takes it: an object keyed by member name,
// each member's documentation, type, limits and whether it is required. Where a member is sent (path, query, header
// or body) is given as x-caitlyn-location, so an agent writing a file knows the identifiers are there too.
func InputSchema(m *spec.Manifest, op *spec.Operation) Schema {
	defs := map[string]any{}
	s := object(m, op.Input, defs, true)
	s["$schema"] = schemaDialect
	s["title"] = op.Name + " input"
	if len(defs) > 0 {
		s["$defs"] = defs
	}
	return s
}

// OutputSchema is the JSON Schema of what the command prints: the thing (the response's payload), a page of a list,
// or the response's body members. A stream's events are not described here.
func OutputSchema(m *spec.Manifest, op *spec.Operation) Schema {
	defs := map[string]any{}
	var s Schema
	if p := op.Payload(); p != nil {
		s = Schema(typeSchema(m, p.Type, defs))
		if p.Documentation != "" {
			s["description"] = clean(p.Documentation)
		}
	} else {
		var body []*spec.Member
		for _, mem := range op.Output {
			if mem.Location == "body" {
				body = append(body, mem)
			}
		}
		s = object(m, body, defs, false)
	}
	s["$schema"] = schemaDialect
	s["title"] = op.Name + " output"
	if len(defs) > 0 {
		s["$defs"] = defs
	}
	return s
}

func object(m *spec.Manifest, members []*spec.Member, defs map[string]any, input bool) Schema {
	props := map[string]any{}
	var required []string
	for _, mem := range members {
		name := mem.Wire
		if input {
			name = mem.Name
		}
		if mem.Location == "status" {
			continue
		}
		p := memberSchema(m, mem, defs)
		if input && mem.Location != "" && mem.Location != "body" {
			p["x-caitlyn-location"] = locationName(mem.Location)
		}
		props[name] = p
		if mem.Required && !mem.Idempotency {
			required = append(required, name)
		}
	}
	s := Schema{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		sort.Strings(required)
		s["required"] = required
	}
	return s
}

func locationName(l string) string {
	switch l {
	case "label":
		return "path"
	case "payload":
		return "body"
	}
	return l
}

func memberSchema(m *spec.Manifest, mem *spec.Member, defs map[string]any) map[string]any {
	s := typeSchema(m, mem.Type, defs)
	if mem.Documentation != "" {
		s["description"] = clean(mem.Documentation)
	}
	if mem.Length != nil {
		switch mem.Type.Type {
		case "string":
			setBound(s, "minLength", mem.Length.Min)
			setBound(s, "maxLength", mem.Length.Max)
		case "list":
			setBound(s, "minItems", mem.Length.Min)
			setBound(s, "maxItems", mem.Length.Max)
		case "map":
			setBound(s, "minProperties", mem.Length.Min)
			setBound(s, "maxProperties", mem.Length.Max)
		}
	}
	if mem.Range != nil {
		setBound(s, "minimum", mem.Range.Min)
		setBound(s, "maximum", mem.Range.Max)
	}
	if mem.Pattern != "" {
		s["pattern"] = mem.Pattern
	}
	if len(mem.Default) > 0 {
		var v any
		if json.Unmarshal(mem.Default, &v) == nil {
			s["default"] = v
		}
	}
	if mem.Deprecated != nil {
		s["deprecated"] = true
	}
	if mem.Sensitive {
		s["writeOnly"] = true
	}
	return s
}

func setBound(s map[string]any, k string, v *float64) {
	if v == nil {
		return
	}
	if *v == float64(int64(*v)) {
		s[k] = int64(*v)
		return
	}
	s[k] = *v
}

func typeSchema(m *spec.Manifest, t *spec.Type, defs map[string]any) map[string]any {
	if t == nil {
		return map[string]any{}
	}
	switch t.Type {
	case "string":
		return map[string]any{"type": "string"}
	case "enum":
		// Enums are open: a newer server may send a value this CLI doesn't know, and the CLI sends one as given
		return map[string]any{"type": "string", "enum": t.Enum()}
	case "intEnum":
		var vals []any
		_ = json.Unmarshal(t.Values, &vals)
		return map[string]any{"type": "integer", "enum": vals}
	case "boolean":
		return map[string]any{"type": "boolean"}
	case "integer":
		return map[string]any{"type": "integer"}
	case "number":
		return map[string]any{"type": "number"}
	case "timestamp":
		return map[string]any{"type": "string", "format": "date-time"}
	case "blob":
		return map[string]any{"type": "string", "contentEncoding": "base64"}
	case "document":
		return map[string]any{}
	case "list":
		return map[string]any{"type": "array", "items": typeSchema(m, t.Member, defs)}
	case "map":
		return map[string]any{"type": "object", "additionalProperties": typeSchema(m, t.Value, defs)}
	case "ref":
		addDef(m, t.Ref, defs)
		return map[string]any{"$ref": "#/$defs/" + t.Ref}
	}
	return map[string]any{}
}

func addDef(m *spec.Manifest, name string, defs map[string]any) {
	if _, ok := defs[name]; ok {
		return
	}
	sh := m.Shapes[name]
	if sh == nil {
		defs[name] = map[string]any{}
		return
	}
	// Placeholder first, so a recursive shape refers to itself rather than looping
	defs[name] = map[string]any{}
	var s map[string]any
	if sh.Type == "union" {
		var one []any
		for _, mem := range sh.Members {
			one = append(one, map[string]any{
				"type":                 "object",
				"properties":           map[string]any{mem.Wire: memberSchema(m, mem, defs)},
				"required":             []string{mem.Wire},
				"additionalProperties": false,
			})
		}
		s = map[string]any{"oneOf": one}
	} else {
		s = object(m, sh.Members, defs, false)
		// A newer server's members are kept, never refused: a thing read back is not closed
		delete(s, "additionalProperties")
	}
	if sh.Documentation != "" {
		s["description"] = clean(sh.Documentation)
	}
	defs[name] = s
}

// clean joins a documentation string's wrapped lines into paragraphs.
func clean(doc string) string {
	paras := strings.Split(strings.TrimSpace(doc), "\n\n")
	for i, p := range paras {
		paras[i] = strings.Join(strings.Fields(p), " ")
	}
	return strings.Join(paras, "\n\n")
}
