package gen

import (
	"strings"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
)

// Hint gives an error the hint an AI agent (or a person) can act on without reading the docs (18.2): complete
// commands that reuse this run's identifiers and flags, the flags that are missing, field errors named by flag,
// and the command's docs page.
func (r *Run) Hint(err error) error {
	if err == nil {
		return nil
	}
	e := cmdutil.FromError(err)
	if e.Silent {
		return e
	}
	if e.Hint == nil {
		e.Hint = &cmdutil.Hint{}
	}
	if e.Hint.Docs == "" {
		e.Hint.Docs = DocsURL(r.C.Spec.Path)
	}
	// Field errors: map each JSON pointer back to the flag that set it
	for i, fp := range e.Fields {
		if fp.Flag != "" {
			continue
		}
		e.Fields[i].Flag = r.flagFor(fp.Pointer)
	}
	if len(e.Hint.Next) > 0 {
		return e
	}
	cmdLine := r.commandLine()
	get, list := r.getCommand(), r.listCommand()
	scope := ""
	if r.C.Op != nil {
		scope = r.C.Op.Scope()
	}
	fill := func(s string) string {
		// A step that gives a flag again ("{command} --if-match <etag>") replaces the value the command had
		line := cmdLine
		for _, flag := range []string{"--if-match", "--idempotency-key"} {
			if strings.Contains(s, "{command} "+flag) {
				line = withoutFlag(line, flag)
			}
		}
		s = strings.ReplaceAll(s, "{command}", line)
		s = strings.ReplaceAll(s, "{get}", get)
		s = strings.ReplaceAll(s, "{list}", list)
		s = strings.ReplaceAll(s, "{scope}", scope)
		return s
	}
	if steps, ok := r.F.Overlay().Next[e.Code]; ok {
		for _, st := range steps {
			if (strings.Contains(st.Run, "{get}") && get == "") || (strings.Contains(st.Run, "{list}") && list == "") {
				continue
			}
			// A step that gives this command a flag it doesn't have would only fail again
			if f := addedFlag(st.Run); f != "" && r.Cobra.Flags().Lookup(f) == nil {
				continue
			}
			e.AddNext(fill(st.Run), st.Why)
		}
		if len(e.Hint.Next) > 0 {
			return e
		}
	}
	switch e.Exit {
	case exitcode.Auth:
		if r.F.CI.In() {
			e.AddNext("set CAITLYN_WORKSPACE and CAITLYN_AUTH=workload-identity (or CAITLYN_TOKEN) in the job", "sign in from CI")
		} else {
			e.AddNext("caitlyn auth login", "sign in")
		}
	case exitcode.Forbidden:
		if scope != "" {
			e.AddNext("caitlyn auth login --scopes "+scope, "sign in with the scope this needs ("+r.C.Op.Permission.Action+")")
		}
	case exitcode.NotFound:
		if list != "" {
			e.AddNext(list, "find a valid identifier")
		}
	case exitcode.Conflict:
		if get != "" {
			e.AddNext(get, "read it again")
		}
		e.AddNext(cmdLine, "then retry")
	case exitcode.NotSupported:
		e.AddNext("caitlyn version", "see your workspace's release and what it supports")
	case exitcode.Connection:
		e.AddNext(cmdLine, "retry; check the workspace is reachable")
	case exitcode.RateLimited:
		e.AddNext(cmdLine, "retry after a short pause")
	}
	if len(e.Hint.Next) == 0 {
		// every error carries a command to run (18.2): at least the command's own help, with its flags and examples
		e.AddNext("caitlyn "+r.C.Spec.Name()+" --help", "see what it takes, with examples")
	}
	return e
}

// flagFor names the flag a JSON pointer's member came from (/name gives --name; /guidance/instructions gives
// --set guidance.instructions=…).
func (r *Run) flagFor(pointer string) string {
	p := strings.TrimPrefix(pointer, "/")
	if p == "" {
		return ""
	}
	parts := strings.Split(p, "/")
	for _, mf := range r.C.Members {
		if mf.Member.Wire == parts[0] && len(parts) == 1 {
			return "--" + mf.Flag
		}
	}
	for _, id := range r.C.Idents {
		for _, mem := range id.ID.Members {
			if mem == parts[0] {
				return "--" + id.Flag
			}
		}
	}
	return "--set " + strings.Join(parts, ".")
}

// withoutFlag drops a flag and its value from a command line commandLine made (each value one shell word).
func withoutFlag(line, flag string) string {
	words := splitQuoted(line)
	out := words[:0]
	for i := 0; i < len(words); i++ {
		if words[i] == flag {
			i++
			continue
		}
		if strings.HasPrefix(words[i], flag+"=") {
			continue
		}
		out = append(out, words[i])
	}
	return strings.Join(out, " ")
}

// splitQuoted splits a command line at spaces outside quotes, keeping each word as written (shellQuote's
// 'it'\”s' is one word).
func splitQuoted(line string) []string {
	var words []string
	var cur strings.Builder
	quoted := false
	rs := []rune(line)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == '\\' && !quoted && i+1 < len(rs):
			cur.WriteRune(r)
			cur.WriteRune(rs[i+1])
			i++
		case r == '\'':
			quoted = !quoted
			cur.WriteRune(r)
		case r == ' ' && !quoted:
			if cur.Len() > 0 {
				words = append(words, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		words = append(words, cur.String())
	}
	return words
}

// addedFlag is the flag a "{command} --flag …" step adds to the failed command, or "".
func addedFlag(step string) string {
	rest, ok := strings.CutPrefix(step, "{command} --")
	if !ok {
		return ""
	}
	name, _, _ := strings.Cut(rest, " ")
	name, _, _ = strings.Cut(name, "=")
	return name
}
