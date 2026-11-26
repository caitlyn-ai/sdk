package gen

import (
	"reflect"
	"regexp"
	"testing"

	"github.com/caitlyn-ai/sdk/cli/internal/spec"
)

// The model has no @sensitive output member yet (webhook triggers and API clients will): this checks the walk on a
// small model of one.
func TestSecretsInFindsSensitiveMembers(t *testing.T) {
	m := &spec.Manifest{Shapes: map[string]*spec.Shape{
		"Trigger": {Type: "structure", Members: []*spec.Member{
			{Name: "id", Wire: "id", Type: &spec.Type{Type: "string"}},
			{Name: "signingSecret", Wire: "signingSecret", Type: &spec.Type{Type: "string"}, Sensitive: true},
			{Name: "clients", Wire: "clients", Type: &spec.Type{Type: "list", Member: &spec.Type{Type: "ref", Ref: "Client"}}},
		}},
		"Client": {Type: "structure", Members: []*spec.Member{
			{Name: "secret", Wire: "secret", Type: &spec.Type{Type: "string"}, Sensitive: true},
		}},
	}}
	op := &spec.Operation{Name: "CreateTrigger", Output: []*spec.Member{
		{Name: "trigger", Location: "payload", Type: &spec.Type{Type: "ref", Ref: "Trigger"}},
	}}
	got := secretsIn(m, op, []byte(`{"id":"t1","signingSecret":"whsec_1","clients":[{"secret":"cs_2"}]}`))
	if !reflect.DeepEqual(got, []string{"whsec_1", "cs_2"}) {
		t.Fatalf("got %v", got)
	}
	if got := secretsIn(m, op, []byte(`{"id":"t1"}`)); len(got) != 0 {
		t.Fatalf("no secret in the response: %v", got)
	}
}

// The CI secret guard only knows a secret by @sensitive, and the model marks none yet. This fails as soon as the model
// gains a member whose name says it is a secret but which isn't marked, so the guard can't silently miss it.
func TestSecretLookingMembersAreSensitive(t *testing.T) {
	m := spec.MustLoad()
	looksSecret := regexp.MustCompile(`(?i)(secret|password|apikey|accesstoken|refreshtoken|idtoken|privatekey)$`)
	check := func(where string, members []*spec.Member) {
		for _, mem := range members {
			if looksSecret.MatchString(mem.Name) && !mem.Sensitive {
				t.Errorf("%s.%s looks like a secret but isn't @sensitive, so CI would print it unmasked", where, mem.Name)
			}
		}
	}
	for name, op := range m.Operations {
		check(name, op.Output)
	}
	for name, sh := range m.Shapes {
		check(name, sh.Members)
	}
}
