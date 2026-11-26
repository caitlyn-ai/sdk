// Package commands wires the hand-written commands and the CLI's other parts (sign-in, the design system's
// prompts and pager, usage data for Caitlyn, updates) into the root command. Each package adds itself in Register, so the root
// command never imports them and tests can run the root with fakes.
package commands

// Register wires everything in. It is called once, by main and by end-to-end tests.
func Register() {
	for _, r := range registrations {
		r()
	}
}

// registrations are added by this package's files, one per area.
var registrations []func()
