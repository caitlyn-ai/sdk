// This file is hand-written, not generated: the readers shorthand for access.set (PROTOCOL.md 10, spec 4.1). Who may
// read a folder or a document is 'inherit', 'public', 'everyone' or {roles, people}; the model's Readers says which with kind.
// scripts/generate.sh keeps every file in go/ that is not marked as generated.

package caitlyn

import "encoding/json"

// ReadersInherit is readers: 'inherit': the folder or document takes its readers from the folder above it. It is
// refused on the root folder, which has no folder above it.
func ReadersInherit() *Readers { return &Readers{Kind: ReadersKindInherit} }

// ReadersPublic is readers: 'public': anyone who can reach the knowledge base, signed in or not, guests and anonymous
// visitors of a public agent included.
func ReadersPublic() *Readers { return &Readers{Kind: ReadersKindPublic} }

// ReadersEveryone is readers: 'everyone': anyone signed in who can read the knowledge base.
func ReadersEveryone() *Readers { return &Readers{Kind: ReadersKindEveryone} }

// ReadersOf is readers: {roles, people}: only these roles and people. Either may be nil.
func ReadersOf(roles, people []string) *Readers {
	return &Readers{Kind: ReadersKindSpecific, Roles: roles, People: people}
}

// MarshalJSON sends the modelled {kind, …} shape: a Readers with roles or people and no Kind is {roles, people}, sent
// as kind specific.
func (r Readers) MarshalJSON() ([]byte, error) {
	type plain Readers
	if r.Kind == "" && (len(r.Roles) > 0 || len(r.People) > 0) {
		r.Kind = ReadersKindSpecific
	}
	return json.Marshal(plain(r))
}
