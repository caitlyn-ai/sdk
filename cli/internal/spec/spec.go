// Package spec reads the CLI's command manifest, commands.json, which codegen/cli writes from the model's scope tree
// (scripts/generate.sh). Every generated command, flag, help text and HTTP binding comes from it, so the CLI and the
// SDKs place each operation the same way and can never disagree.
package spec

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
)

//go:embed commands.json
var manifestJSON []byte

// Manifest is commands.json.
type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Version       string `json:"version"`
	ModelVersion  string `json:"modelVersion"`
	Service       string `json:"service"`
	// Permissions maps a permission ("agents.update") to the OAuth scope that grants it ("agents:write").
	Permissions map[string]string     `json:"permissions"`
	Commands    []*Command            `json:"commands"`
	Operations  map[string]*Operation `json:"operations"`
	Shapes      map[string]*Shape     `json:"shapes"`
}

// Command is one generated command: a method of the scope tree.
type Command struct {
	// Path is the command's words after `caitlyn`: ["knowledge-bases", "documents", "get"].
	Path []string `json:"path"`
	// Place is the method's place in the SDKs: caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).get.
	Place string `json:"place"`
	// Operation is the operation it calls; empty for a `wait` (Kind "wait").
	Operation string `json:"operation,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Hidden    bool   `json:"hidden,omitempty"`
	// Args are the positional identifiers (the scope's own); Identifiers the ones above it, as flags.
	Args        []*Identifier `json:"args"`
	Identifiers []*Identifier `json:"identifiers"`
	// Fixed are members a named scope fills with a fixed value: agent.draft's version is "draft".
	Fixed           map[string]string `json:"fixed,omitempty"`
	LongRunning     *LongRunning      `json:"longRunning,omitempty"`
	Creates         *Creates          `json:"creates,omitempty"`
	Estimate        string            `json:"estimate,omitempty"`
	IfMatchOptional bool              `json:"ifMatchOptional,omitempty"`
	// Waits is a `wait` command's watch.
	Waits *LongRunning `json:"waits,omitempty"`
	// ScopeWatch is the watch that follows the thing this command acts on, for --wait.
	ScopeWatch *LongRunning `json:"scopeWatch,omitempty"`
}

// Name is the command's path as typed: "knowledge-bases documents get".
func (c *Command) Name() string { return strings.Join(c.Path, " ") }

// Verb is the command's last word.
func (c *Command) Verb() string { return c.Path[len(c.Path)-1] }

// Identifier is a scope identifier the command takes, positionally or as a flag.
type Identifier struct {
	// Identifier is the scope identifier's name, which is also the input member it usually fills: knowledgeBaseId.
	Identifier string `json:"identifier"`
	// Members are the input members it fills (PutAccess's `document` for a document's access).
	Members []string `json:"members"`
	// TrimSlashes: a folder path sent in a request path, sent without its first and last slash.
	TrimSlashes bool `json:"trimSlashes,omitempty"`
	// Compact: the value is AGENT@version, and the part after the last @ fills these members.
	Compact *Compact `json:"compact,omitempty"`
}

// Compact is the version half of AGENT@version.
type Compact struct {
	Identifier string   `json:"identifier"`
	Members    []string `json:"members"`
}

// LongRunning is the watch that follows a call's work (@longRunning), or a scope's watch.
type LongRunning struct {
	Watch   string `json:"watch"`
	Filter  string `json:"filter,omitempty"`
	Cancels bool   `json:"cancels,omitempty"`
}

// Creates names the scope a create returns, and where its identifier comes from (output:id).
type Creates struct {
	Collection string `json:"collection"`
	Source     string `json:"source"`
}

// Operation is one modelled operation with its HTTP bindings.
type Operation struct {
	Name          string `json:"name"`
	Title         string `json:"title,omitempty"`
	Documentation string `json:"documentation,omitempty"`
	Method        string `json:"method"`
	URI           string `json:"uri"`
	Code          int    `json:"code"`
	// Stability is the model's: ga, preview (beta, its earlier name), experimental or internal. Maturity reads it.
	Stability     string              `json:"stability"`
	Since         string              `json:"since,omitempty"`
	Readonly      bool                `json:"readonly,omitempty"`
	Idempotent    bool                `json:"idempotent,omitempty"`
	RetrySafe     bool                `json:"retrySafe"`
	Deprecated    *string             `json:"deprecated,omitempty"`
	Input         []*Member           `json:"input"`
	Output        []*Member           `json:"output"`
	Paginated     *Paginated          `json:"paginated,omitempty"`
	SSE           *SSE                `json:"sse,omitempty"`
	LongRunning   *LongRunning        `json:"longRunning,omitempty"`
	EstimateFor   string              `json:"estimateFor,omitempty"`
	UploadTarget  string              `json:"uploadTarget,omitempty"`
	Presigned     bool                `json:"presignedUpload,omitempty"`
	IdempotencyHd string              `json:"idempotencyHeader,omitempty"`
	IfMatch       *IfMatch            `json:"ifMatch,omitempty"`
	Permission    *Permission         `json:"permission,omitempty"`
	NoPermission  bool                `json:"noPermission,omitempty"`
	Interactive   bool                `json:"interactiveOnly,omitempty"`
	Impact        string              `json:"impact,omitempty"`
	Filterable    map[string][]string `json:"filterable,omitempty"`
	Sortable      *Sortable           `json:"sortable,omitempty"`
	Errors        []*ErrorShape       `json:"errors"`
	Examples      []*Example          `json:"examples,omitempty"`
}

// Paginated is the operation's @paginated.
type Paginated struct {
	InputToken  string `json:"inputToken"`
	OutputToken string `json:"outputToken"`
	Items       string `json:"items"`
	PageSize    string `json:"pageSize"`
}

// SSE is the operation's @sseEvents.
type SSE struct {
	Events     *Type    `json:"events"`
	Final      string   `json:"final,omitempty"`
	ResumeWith string   `json:"resumeWith,omitempty"`
	EventTypes []string `json:"eventTypes"`
}

// IfMatch is the operation's If-Match header member.
type IfMatch struct {
	Member   string `json:"member"`
	Required bool   `json:"required"`
	Optional bool   `json:"optional,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// Permission is the operation's @permission, with the scope permissions.json maps it to.
type Permission struct {
	Action     string          `json:"action"`
	Scope      string          `json:"scope,omitempty"`
	AlsoScopes []string        `json:"alsoScopes,omitempty"`
	Callers    []string        `json:"callers,omitempty"`
	Entity     json.RawMessage `json:"entity,omitempty"`
}

// Level is the grant the permission checks on its entity ("update"), or "".
func (p *Permission) Level() string {
	var e struct {
		Level string `json:"level"`
		Type  string `json:"type"`
	}
	_ = json.Unmarshal(p.Entity, &e)
	return e.Level
}

// EntityType is the entity the grant is checked on ("agents"), or "".
func (p *Permission) EntityType() string {
	var e struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(p.Entity, &e)
	return e.Type
}

// Sortable is the operation's @sortable.
type Sortable struct {
	Fields []string `json:"fields"`
}

// ErrorShape is an error the operation can return.
type ErrorShape struct {
	Shape  string   `json:"shape"`
	Status int      `json:"status"`
	Codes  []string `json:"codes,omitempty"`
}

// Example is one @examples entry.
type Example struct {
	Title         string          `json:"title"`
	Documentation string          `json:"documentation,omitempty"`
	Input         json.RawMessage `json:"input"`
	Output        json.RawMessage `json:"output,omitempty"`
	Error         *ExampleError   `json:"error,omitempty"`
}

// ExampleError is an example's error.
type ExampleError struct {
	Shape   string          `json:"shape"`
	Content json.RawMessage `json:"content"`
}

// Member is an input or output member.
type Member struct {
	Name string `json:"name"`
	// Location is label, query, header, body, payload or status.
	Location      string          `json:"location"`
	Wire          string          `json:"wire"`
	Required      bool            `json:"required,omitempty"`
	Documentation string          `json:"documentation,omitempty"`
	Type          *Type           `json:"type"`
	Default       json.RawMessage `json:"default,omitempty"`
	Range         *Bounds         `json:"range,omitempty"`
	Length        *Bounds         `json:"length,omitempty"`
	Pattern       string          `json:"pattern,omitempty"`
	Since         string          `json:"since,omitempty"`
	Sensitive     bool            `json:"sensitive,omitempty"`
	Clearable     bool            `json:"clearable,omitempty"`
	Idempotency   bool            `json:"idempotencyToken,omitempty"`
	Deprecated    *string         `json:"deprecated,omitempty"`
}

// Bounds is a @range or @length.
type Bounds struct {
	Min *float64 `json:"min,omitempty"`
	Max *float64 `json:"max,omitempty"`
}

// Type is a member's type: simple types inline, structures and unions by reference into Manifest.Shapes.
type Type struct {
	// Type is string, enum, intEnum, boolean, integer, number, timestamp, blob, document, list, map or ref.
	Type      string          `json:"type"`
	Values    json.RawMessage `json:"values,omitempty"`
	Member    *Type           `json:"member,omitempty"`
	Value     *Type           `json:"value,omitempty"`
	Ref       string          `json:"ref,omitempty"`
	Streaming bool            `json:"streaming,omitempty"`
}

// Enum returns an enum's values (as strings, for an intEnum too).
func (t *Type) Enum() []string {
	if t == nil || len(t.Values) == 0 {
		return nil
	}
	var raw []any
	_ = json.Unmarshal(t.Values, &raw)
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		out = append(out, fmt.Sprint(v))
	}
	return out
}

// Scalar reports whether the type is one flag value: not a list, map, structure, union or document.
func (t *Type) Scalar() bool {
	switch t.Type {
	case "list", "map", "ref", "document", "blob":
		return false
	}
	return true
}

// Shape is a structure or union.
type Shape struct {
	Type          string    `json:"type"`
	Documentation string    `json:"documentation,omitempty"`
	Members       []*Member `json:"members"`
}

var (
	loadOnce sync.Once
	loaded   *Manifest
	loadErr  error
)

// Load returns the embedded manifest, parsed once.
func Load() (*Manifest, error) {
	loadOnce.Do(func() {
		loaded, loadErr = Parse(manifestJSON)
	})
	return loaded, loadErr
}

// MustLoad is Load for code that runs after the root command has loaded the manifest successfully.
func MustLoad() *Manifest {
	m, err := Load()
	if err != nil {
		panic(err)
	}
	return m
}

// Parse reads a manifest.
func Parse(b []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("the command manifest could not be read: %w", err)
	}
	if m.SchemaVersion != 1 {
		return nil, fmt.Errorf("the command manifest has schema version %d; this CLI reads version 1", m.SchemaVersion)
	}
	return &m, nil
}

// Raw is the embedded manifest's bytes, for `caitlyn commands` and the docs.
func Raw() []byte { return manifestJSON }

// Op returns an operation by name, or nil.
func (m *Manifest) Op(name string) *Operation { return m.Operations[name] }

// OperationNames lists the operations, sorted.
func (m *Manifest) OperationNames() []string {
	out := make([]string, 0, len(m.Operations))
	for n := range m.Operations {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Member returns an input member by name, or nil.
func (o *Operation) Member(name string) *Member {
	for _, m := range o.Input {
		if m.Name == name {
			return m
		}
	}
	return nil
}

// OutputMember returns an output member by name, or nil.
func (o *Operation) OutputMember(name string) *Member {
	for _, m := range o.Output {
		if m.Name == name {
			return m
		}
	}
	return nil
}

// Payload is the output's @httpPayload member (a thing), or nil.
func (o *Operation) Payload() *Member {
	for _, m := range o.Output {
		if m.Location == "payload" {
			return m
		}
	}
	return nil
}

// Scope is the OAuth scope the operation needs, or "" (an operation anyone signed in may call).
func (o *Operation) Scope() string {
	if o.Permission == nil {
		return ""
	}
	return o.Permission.Scope
}

// Codes lists every error code the operation can return, with its HTTP status.
func (o *Operation) Codes() map[string]int {
	out := map[string]int{}
	for _, e := range o.Errors {
		for _, c := range e.Codes {
			out[c] = e.Status
		}
	}
	return out
}

// Maturity is how the CLI labels a stability level: "preview" for preview and for beta (the same level, under the
// name the model used before), "experimental" for experimental (beta builds only), and "" for anything else, ga
// included.
func Maturity(stability string) string {
	switch stability {
	case "preview", "beta":
		return "preview"
	case "experimental":
		return "experimental"
	}
	return ""
}

// MaturityMarker is the help's marker for a maturity: "[Preview]", "[Experimental]", or "" for none.
func MaturityMarker(maturity string) string {
	if maturity == "" {
		return ""
	}
	return "[" + strings.ToUpper(maturity[:1]) + maturity[1:] + "]"
}
