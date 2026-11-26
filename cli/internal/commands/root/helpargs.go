package root

import (
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// helpArgs makes `help` a subcommand at every level: `caitlyn ai help` and `caitlyn agents draft save help` show the
// same help as `--help` there, for every group and command in the tree, generated ones included, because the word is
// read here rather than by each command.
//
// `help` counts only in the subcommand position: as the last word after the command's path, where the command would
// refuse it as an argument. A command that takes a positional argument gets `help` as that argument (an agent ID
// of "help" is never shadowed), and a real command named help (`caitlyn help`, with its topics) is left to run.
// Everything else is passed on unchanged.
func helpArgs(root *cobra.Command, args []string) []string {
	c := root
	at := -1
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			return args
		}
		if strings.HasPrefix(a, "-") && a != "-" {
			if takesValue(c, a) {
				i++
			}
			continue
		}
		if at >= 0 {
			return args // a word after help: not ours
		}
		if child := subcommand(c, a); child != nil {
			if child.DisableFlagParsing {
				return args // caitlyn api reads its own arguments
			}
			c = child
			continue
		}
		// a group that declares no Args would still refuse it, as an unknown command
		if a != "help" || (c.ValidateArgs([]string{a}) == nil && !(c.HasSubCommands() && c.Args == nil)) {
			return args
		}
		at = i
	}
	if at < 0 {
		return args
	}
	out := append([]string{}, args[:at]...)
	out = append(out, "--help")
	return append(out, args[at+1:]...)
}

// subcommand is c's subcommand called name, or one of its aliases.
func subcommand(c *cobra.Command, name string) *cobra.Command {
	for _, s := range c.Commands() {
		if s.Name() == name || s.HasAlias(name) {
			return s
		}
	}
	return nil
}

// takesValue says whether the flag word a, on c, is followed by its value as the next word (--profile work, -o json),
// rather than carrying it (--output=json) or taking none (--yes).
func takesValue(c *cobra.Command, a string) bool {
	if strings.Contains(a, "=") {
		return false
	}
	if name, ok := strings.CutPrefix(a, "--"); ok {
		return needsValue(lookup(c, name, false))
	}
	// -yo json: in a run of shorthands, the first that takes a value takes the rest of the word, or the next word
	short := strings.TrimPrefix(a, "-")
	for j := range len(short) {
		fl := lookup(c, short[j:j+1], true)
		if fl == nil {
			return false
		}
		if needsValue(fl) {
			return j == len(short)-1
		}
	}
	return false
}

func needsValue(fl *pflag.Flag) bool {
	return fl != nil && fl.NoOptDefVal == "" && fl.Value.Type() != "bool"
}

func lookup(c *cobra.Command, name string, short bool) *pflag.Flag {
	for _, fs := range []*pflag.FlagSet{c.Flags(), c.PersistentFlags(), c.InheritedFlags()} {
		var fl *pflag.Flag
		if short {
			fl = fs.ShorthandLookup(name)
		} else {
			fl = fs.Lookup(name)
		}
		if fl != nil {
			return fl
		}
	}
	return nil
}
