package core

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Range is one @range rule a request carries (PROTOCOL.md 3): Where is "query" (Path a parameter name) or "body"
// (Path a JSON Pointer pattern in which * stands for any list item or map value); a nil bound is no bound.
type Range struct {
	Where, Path string
	Min, Max    *float64
}

// Bound is a range bound, for the generated rules.
func Bound(v float64) *float64 { return &v }

// checkRanges refuses a request with a value outside its rule's range before it is sent: VALIDATION_FAILED and a
// field error for each value, as the server's 400 would be, but with status 0. Client.Do raises it as the
// operation's 400 error (ValidationError).
func checkRanges(rules []Range, req *Request) *APIError {
	if len(rules) == 0 {
		return nil
	}
	var body any
	if len(req.Body) > 0 && strings.HasPrefix(req.ContentType, "application/json") {
		if err := json.Unmarshal(req.Body, &body); err != nil {
			body = nil // not JSON: nothing in it to check
		}
	}
	var problems []FieldError
	for _, r := range rules {
		if r.Where == "query" {
			for _, raw := range req.Query[r.Path] {
				n, err := strconv.ParseFloat(raw, 64)
				if err == nil && outside(r, n) {
					problems = append(problems, FieldError{Parameter: r.Path, Code: "VALIDATION_FAILED",
						Detail: fmt.Sprintf("`%s` must be %s; it is %s.", r.Path, bounds(r), raw)})
				}
			}
			continue
		}
		type at struct {
			pointer string
			value   any
		}
		cur := []at{{"", body}}
		for _, seg := range strings.Split(r.Path, "/")[1:] {
			var next []at
			for _, a := range cur {
				switch v := a.value.(type) {
				case map[string]any:
					if seg == "*" {
						keys := make([]string, 0, len(v))
						for k := range v {
							keys = append(keys, k)
						}
						sort.Strings(keys)
						for _, k := range keys {
							next = append(next, at{a.pointer + "/" + escapePointer(k), v[k]})
						}
					} else if c, ok := v[seg]; ok {
						next = append(next, at{a.pointer + "/" + escapePointer(seg), c})
					}
				case []any:
					if seg == "*" {
						for i, c := range v {
							next = append(next, at{a.pointer + "/" + strconv.Itoa(i), c})
						}
					}
				}
			}
			cur = next
		}
		for _, a := range cur {
			if n, ok := a.value.(float64); ok && outside(r, n) {
				problems = append(problems, FieldError{Pointer: a.pointer, Code: "VALIDATION_FAILED",
					Detail: fmt.Sprintf("`%s` must be %s; it is %s.", a.pointer, bounds(r), strconv.FormatFloat(n, 'f', -1, 64))})
			}
		}
	}
	if len(problems) == 0 {
		return nil
	}
	detail := problems[0].Detail
	if len(problems) > 1 {
		parts := make([]string, len(problems))
		for i, p := range problems {
			parts[i] = p.Detail
		}
		detail = fmt.Sprintf("%d values are out of range. %s", len(problems), strings.Join(parts, " "))
	}
	e := sdkError("VALIDATION_FAILED", "The request is not valid", nil)
	e.Detail, e.Errors = detail, problems
	return e
}

func outside(r Range, v float64) bool {
	return (r.Min != nil && v < *r.Min) || (r.Max != nil && v > *r.Max)
}

func bounds(r Range) string {
	f := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	switch {
	case r.Min != nil && r.Max != nil:
		return "between " + f(*r.Min) + " and " + f(*r.Max)
	case r.Min != nil:
		return "at least " + f(*r.Min)
	default:
		return "at most " + f(*r.Max)
	}
}

func escapePointer(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}
