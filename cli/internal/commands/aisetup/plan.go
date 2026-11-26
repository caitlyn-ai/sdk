package aisetup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/caitlyn-ai/sdk/cli/internal/commands/describe"
	"github.com/caitlyn-ai/sdk/cli/internal/config"
)

// What setup can give the tools (--with).
const (
	WithInstructions = "instructions"
	WithSkill        = "skill"
	WithMCP          = "mcp"
	WithDefaults     = "defaults"
)

// Offers are what setup can give, in the order it asks.
var Offers = []string{WithInstructions, WithSkill, WithMCP, WithDefaults}

// Why a part of the plan was left out (Skip.Why).
const (
	SkipNotSupported = "NOT_SUPPORTED"
	SkipNoWorkspace  = "NO_WORKSPACE"
	SkipEdited       = "EDITED"
	SkipNotOurs      = "NOT_MADE_BY_SETUP"
	SkipShared       = "SHARED"
)

// The line that makes Claude Code read AGENTS.md, and the marker before it that says setup put it there.
const (
	importComment = "<!-- " + describe.StampTag + ": Claude Code reads the Caitlyn CLI section from AGENTS.md -->"
	importLine    = "@AGENTS.md"
)

// projectFile is the project's configuration file.
const projectFile = ".caitlyn.toml"

// Change is one file in a plan: what happens to it and why, as people and AI tools are shown it.
type Change struct {
	file    *describe.FileChange
	Action  string   `json:"action"`
	File    string   `json:"file"`
	What    string   `json:"what"`
	Tools   []string `json:"tools,omitempty"`
	Summary string   `json:"summary,omitempty"`
	Added   int      `json:"added"`
	Removed int      `json:"removed"`
	// Edited is a file changed by hand since setup wrote it: it is replaced or removed only once a person agrees.
	Edited bool   `json:"edited,omitempty"`
	Diff   string `json:"diff"`
	// group ties the files that go together (the skill's two): agreeing or declining one is both.
	group string
	notes []string
	tools map[string]bool
}

// Skip is a part of the plan that was left out, and why.
type Skip struct {
	What   string `json:"what"`
	Tool   string `json:"tool,omitempty"`
	File   string `json:"file,omitempty"`
	Why    string `json:"why"`
	Detail string `json:"detail"`
}

// Plan is what setup, update or remove would do in a project.
type Plan struct {
	Root      string    `json:"root"`
	Workspace string    `json:"workspace,omitempty"`
	Tools     []string  `json:"tools"`
	With      []string  `json:"with"`
	Changes   []*Change `json:"changes"`
	Skipped   []Skip    `json:"skipped"`

	byFile map[string]*Change
}

// Request is what to plan.
type Request struct {
	// Root is the project folder.
	Root string
	// Version is the CLI's; Workspace the one to name in the files ("" for none: --no-workspace, or not signed in).
	Version, Workspace string
	// Current is the profile's workspace even with --no-workspace (update keeps a file's own choice).
	Current     string
	NoWorkspace bool
	Tools       []*Tool
	With        map[string]bool
	// Defaults are the project file's keys to set, besides the workspace (agent, knowledge_base).
	Defaults map[string]string
	// Tree describes the CLI, for the skill (built only when the skill is planned).
	Tree func() *describe.Tree
}

func newPlan(root string) *Plan {
	return &Plan{Root: root, Tools: []string{}, With: []string{}, Changes: []*Change{}, Skipped: []Skip{}, byFile: map[string]*Change{}}
}

// file is the plan's change to a file (relative to the root, with forward slashes), read on first use.
func (p *Plan) file(rel, what string) (*Change, error) {
	if c := p.byFile[rel]; c != nil {
		return c, nil
	}
	fc, err := describe.ReadFileChange(p.Root, filepath.Join(p.Root, filepath.FromSlash(rel)))
	if err != nil {
		return nil, err
	}
	c := &Change{file: fc, File: rel, What: what, tools: map[string]bool{}}
	p.byFile[rel] = c
	p.Changes = append(p.Changes, c)
	return c, nil
}

func (p *Plan) skip(s Skip) { p.Skipped = append(p.Skipped, s) }

// finish works out each change's action, counts and diff, and drops the files that wouldn't change.
func (p *Plan) finish() {
	var kept []*Change
	for _, c := range p.Changes {
		if !c.file.Changed() {
			continue
		}
		c.Action = c.file.Action()
		c.Added, c.Removed = c.file.Counts()
		c.Diff = c.file.Diff()
		c.Tools = sortedNames(c.tools)
		c.Summary = strings.Join(c.notes, ", ")
		kept = append(kept, c)
	}
	if kept == nil {
		kept = []*Change{}
	}
	p.Changes = kept
}

// drop takes changes out of the plan (the person declined them), with the same reason for each.
func (p *Plan) drop(group string, why, detail string) {
	var kept []*Change
	for _, c := range p.Changes {
		if c.group == group {
			p.skip(Skip{What: c.What, File: c.File, Why: why, Detail: detail})
			continue
		}
		kept = append(kept, c)
	}
	if kept == nil {
		kept = []*Change{}
	}
	p.Changes = kept
}

// stampFor is the stamp to write: the request's workspace, unless the file it replaces chose none.
func (r *Request) stamp() describe.Stamp { return describe.NewStamp(r.Version, r.Workspace) }

// PlanSetup plans setting up the tools with what was chosen.
func PlanSetup(r *Request) (*Plan, error) {
	p := newPlan(r.Root)
	p.Workspace = r.Workspace
	selected := map[string]bool{}
	for _, t := range r.Tools {
		selected[t.Name] = true
		p.Tools = append(p.Tools, t.Name)
	}
	for _, w := range Offers {
		if r.With[w] {
			p.With = append(p.With, w)
		}
	}
	stamp := r.stamp()
	if r.With[WithInstructions] {
		if err := planInstructions(p, r, selected, stamp); err != nil {
			return nil, err
		}
	}
	if r.With[WithSkill] {
		for _, t := range r.Tools {
			if !t.Skill {
				p.skip(Skip{What: WithSkill, Tool: t.Name, Why: SkipNotSupported, Detail: "The CLI's skill is for Claude Code for now."})
			} else if err := planSkill(p, r, stamp); err != nil {
				return nil, err
			}
		}
	}
	if r.With[WithMCP] {
		done := map[string]bool{}
		for _, t := range r.Tools {
			switch {
			case t.MCP == "":
				p.skip(Skip{What: WithMCP, Tool: t.Name, Why: SkipNotSupported, Detail: t.Label + " keeps its MCP servers outside the project for now: connect it yourself (https://build.caitlyn.ai/tools/connect-an-mcp-client/)."})
			case r.Workspace == "":
				p.skip(Skip{What: WithMCP, Tool: t.Name, Why: SkipNoWorkspace, Detail: noWorkspaceDetail(r, "The MCP server's entry names the workspace")})
			case !done[t.MCP]:
				done[t.MCP] = true
				client, _ := describe.FindMCPClient(t.MCP)
				if err := planMCP(p, client, r.Workspace, t.Name); err != nil {
					return nil, err
				}
			default:
				p.byFile[mcpFile(t.MCP)].tools[t.Name] = true
			}
		}
	}
	if r.With[WithDefaults] {
		if r.Workspace == "" {
			p.skip(Skip{What: WithDefaults, File: projectFile, Why: SkipNoWorkspace, Detail: noWorkspaceDetail(r, "The project defaults name the workspace")})
		} else if err := planDefaults(p, r); err != nil {
			return nil, err
		}
	}
	p.finish()
	return p, nil
}

func noWorkspaceDetail(r *Request, what string) string {
	if r.NoWorkspace {
		return what + ", and --no-workspace leaves it out."
	}
	return what + ", and no workspace is chosen: sign in first (caitlyn auth login), or name it with --workspace."
}

func mcpFile(client string) string {
	c, _ := describe.FindMCPClient(client)
	return filepath.ToSlash(c.File)
}

// planInstructions puts the section in each selected tool's file. AGENTS.md carries it for Cursor and Codex, and when
// no tool was found (most tools read it); Claude Code then imports AGENTS.md from CLAUDE.md rather than repeating it.
func planInstructions(p *Plan, r *Request, selected map[string]bool, stamp describe.Stamp) error {
	agents, err := p.file(agentsMD, WithInstructions)
	if err != nil {
		return err
	}
	_, hasSection := describe.FindSection(agents.file.Before)
	useAgents := selected["cursor"] || selected["codex"] || len(selected) == 0 || hasSection
	if useAgents {
		putSection(agents, stamp)
		for _, n := range []string{"cursor", "codex"} {
			if selected[n] {
				agents.tools[n] = true
			}
		}
	}
	if selected["claude-code"] {
		claude, err := p.file(claudeMD, WithInstructions)
		if err != nil {
			return err
		}
		claude.tools["claude-code"] = true
		if useAgents {
			agents.tools["claude-code"] = true
			if sec, ok := describe.FindSection(claude.file.After); ok && sec.Stamped {
				// AGENTS.md carries it now: CLAUDE.md imports it instead of keeping its own copy
				claude.file.After = describe.RemoveLines(claude.file.After, sec.Start, sec.End)
				claude.notes = append(claude.notes, describe.SectionHeading+" moved to AGENTS.md")
			}
			putImport(claude)
		} else {
			putSection(claude, stamp)
		}
	}
	for _, n := range []string{"copilot", "gemini-cli"} {
		if !selected[n] {
			continue
		}
		c, err := p.file(FindTool(n).Instructions, WithInstructions)
		if err != nil {
			return err
		}
		c.tools[n] = true
		putSection(c, stamp)
	}
	return nil
}

func putSection(c *Change, stamp describe.Stamp) {
	after := describe.ReplaceSection(c.file.After, describe.StampedSnippet(stamp))
	if after != c.file.After {
		c.notes = append(c.notes, describe.SectionHeading)
	}
	c.file.After = after
}

// hasImport reports whether CLAUDE.md already reads AGENTS.md (anyone's @AGENTS.md line).
func hasImport(doc string) bool {
	for _, l := range strings.Split(doc, "\n") {
		if t := strings.TrimSpace(l); t == importLine || t == "@./AGENTS.md" {
			return true
		}
	}
	return false
}

func putImport(c *Change) {
	if hasImport(c.file.After) {
		return
	}
	block := importComment + "\n" + importLine + "\n"
	if strings.TrimSpace(c.file.After) == "" {
		c.file.After = block
	} else {
		c.file.After = strings.TrimRight(c.file.After, "\n") + "\n\n" + block
	}
	c.notes = append(c.notes, importLine)
}

// ourImport finds setup's import in CLAUDE.md: lines [start, end).
func ourImport(doc string) (start, end int, ok bool) {
	lines := strings.Split(doc, "\n")
	for i, l := range lines {
		if strings.TrimSpace(l) == importComment {
			end = i + 1
			if end < len(lines) && strings.TrimSpace(lines[end]) == importLine {
				end++
			}
			return i, end, true
		}
	}
	return 0, 0, false
}

// planSkill writes the CLI's skill for Claude Code. A skill changed by hand since setup wrote it (or one setup didn't
// write) is marked Edited: it is only replaced once a person agrees.
func planSkill(p *Plan, r *Request, stamp describe.Stamp) error {
	files := describe.StampSkill(describe.Skill(r.Tree(), stamp.Workspace), stamp)
	skill, err := p.file(skillDir+"/SKILL.md", WithSkill)
	if err != nil {
		return err
	}
	edited := false
	if skill.file.Exists {
		refs, _ := os.ReadFile(filepath.Join(r.Root, filepath.FromSlash(skillDir), "references", "commands.md"))
		mark, ok := describe.ReadSkillMark(skill.file.Before, string(refs))
		edited = !ok || mark.Edited
	}
	for _, sf := range files {
		c, err := p.file(skillDir+"/"+sf.Path, WithSkill)
		if err != nil {
			return err
		}
		c.file.After = sf.Text
		c.tools["claude-code"] = true
		c.Edited = edited
		c.group = WithSkill
	}
	return nil
}

func planMCP(p *Plan, client describe.MCPClient, workspace, tool string) error {
	plan, err := describe.PlanMCP(client, workspace, p.Root)
	if err != nil {
		return err
	}
	rel := filepath.ToSlash(client.File)
	c := &Change{file: plan.Change, File: rel, What: WithMCP, tools: map[string]bool{tool: true}}
	p.byFile[rel] = c
	p.Changes = append(p.Changes, c)
	note := `"` + describe.MCPServerName + `" server`
	switch plan.Others {
	case 0:
	case 1:
		note += ", 1 other server kept"
	default:
		note += fmt.Sprintf(", %d other servers kept", plan.Others)
	}
	c.notes = append(c.notes, note)
	return nil
}

// planDefaults sets the project file's workspace (and the default agent and knowledge base, when the profile has
// them), keeping everything else in it.
func planDefaults(p *Plan, r *Request) error {
	c, err := p.file(projectFile, WithDefaults)
	if err != nil {
		return err
	}
	keys := []string{"workspace"}
	values := map[string]string{"workspace": r.Workspace}
	for _, k := range []string{"agent", "knowledge_base"} {
		if v := r.Defaults[k]; v != "" {
			keys = append(keys, k)
			values[k] = v
		}
	}
	current := map[string]any{}
	_ = toml.Unmarshal([]byte(c.file.After), &current)
	for _, k := range keys {
		if s, _ := current[k].(string); s == values[k] {
			continue
		}
		after, err := config.SetProjectText(c.file.After, k, values[k])
		if err != nil {
			return err
		}
		c.file.After = after
		c.notes = append(c.notes, k+" = "+values[k])
	}
	return nil
}

// item is something setup made that is in the project now.
type item struct {
	what, rel string
	tools     []string
	stamp     describe.Stamp
	edited    bool
	client    describe.MCPClient
	// workspace is the one an MCP entry or the project file names
	workspace string
}

// instructionFiles are the files that can carry the section, and the tools that read each.
var instructionFiles = []string{agentsMD, claudeMD, copilotMD, geminiMD}

func toolsReading(rel string) []string {
	var out []string
	for _, t := range Tools {
		if t.Instructions == rel {
			out = append(out, t.Name)
		}
	}
	return out
}

// inventory is everything setup made that is in the project: stamped sections, its import in CLAUDE.md, the stamped
// skill, the caitlyn MCP entries, and the project file's workspace.
func inventory(root string) ([]item, error) {
	var out []item
	read := func(rel string) (string, bool, error) {
		fc, err := describe.ReadFileChange(root, filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", false, err
		}
		return fc.Before, fc.Exists, nil
	}
	imports := false
	for _, rel := range instructionFiles {
		doc, ok, err := read(rel)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if sec, found := describe.FindSection(doc); found && sec.Stamped {
			out = append(out, item{what: WithInstructions, rel: rel, tools: toolsReading(rel), stamp: sec.Stamp})
		}
		if rel == claudeMD {
			if _, _, found := ourImport(doc); found {
				imports = true
				out = append(out, item{what: "import", rel: rel, tools: []string{"claude-code"}})
			}
		}
	}
	if imports {
		for i := range out {
			if out[i].rel == agentsMD {
				out[i].tools = append(out[i].tools, "claude-code")
			}
		}
	}
	skill, ok, err := read(skillDir + "/SKILL.md")
	if err != nil {
		return nil, err
	}
	if ok {
		refs, _, _ := read(skillDir + "/references/commands.md")
		if mark, found := describe.ReadSkillMark(skill, refs); found {
			out = append(out, item{what: WithSkill, rel: skillDir + "/SKILL.md", tools: []string{"claude-code"}, stamp: mark.Stamp, edited: mark.Edited})
		}
	}
	for _, t := range Tools {
		if t.MCP == "" {
			continue
		}
		client, _ := describe.FindMCPClient(t.MCP)
		entry, err := describe.MCPEntry(client, root)
		if err != nil {
			return nil, err
		}
		url, _ := entry["url"].(string)
		if entry == nil || describe.HoldsCredentials(entry) || !strings.HasPrefix(url, "https://") || !strings.HasSuffix(url, "/api/mcp") {
			continue
		}
		ws := strings.TrimSuffix(strings.TrimPrefix(url, "https://"), "/api/mcp")
		out = append(out, item{what: WithMCP, rel: filepath.ToSlash(client.File), tools: []string{t.Name}, client: client, workspace: ws})
	}
	if doc, ok, err := read(projectFile); err != nil {
		return nil, err
	} else if ok {
		m := map[string]any{}
		if toml.Unmarshal([]byte(doc), &m) == nil {
			if ws, _ := m["workspace"].(string); ws != "" {
				out = append(out, item{what: WithDefaults, rel: projectFile, workspace: ws})
			}
		}
	}
	return out, nil
}

// updateWorkspace is the workspace an update writes in place of old: the profile's, unless the file chose none (or
// --no-workspace), or no workspace is chosen now, when the file keeps its own.
func (r *Request) updateWorkspace(old string) string {
	switch {
	case r.NoWorkspace || old == "":
		return ""
	case r.Current == "":
		return old
	}
	return r.Current
}

// PlanUpdate plans regenerating everything setup made that is in the project, and nothing else.
func PlanUpdate(r *Request) (*Plan, error) {
	p := newPlan(r.Root)
	p.Workspace = r.Workspace
	items, err := inventory(r.Root)
	if err != nil {
		return nil, err
	}
	tools, with := map[string]bool{}, map[string]bool{}
	for _, it := range items {
		if it.what == WithDefaults {
			continue
		}
		for _, t := range it.tools {
			tools[t] = true
		}
		switch it.what {
		case WithInstructions:
			with[WithInstructions] = true
			c, err := p.file(it.rel, WithInstructions)
			if err != nil {
				return nil, err
			}
			for _, t := range it.tools {
				c.tools[t] = true
			}
			putSection(c, describe.NewStamp(r.Version, r.updateWorkspace(it.stamp.Workspace)))
		case WithSkill:
			with[WithSkill] = true
			if err := planSkill(p, r, describe.NewStamp(r.Version, r.updateWorkspace(it.stamp.Workspace))); err != nil {
				return nil, err
			}
		case WithMCP:
			with[WithMCP] = true
			ws := it.workspace
			if r.Current != "" && !r.NoWorkspace {
				ws = r.Current
			}
			if err := planMCP(p, it.client, ws, it.tools[0]); err != nil {
				return nil, err
			}
		}
	}
	p.Tools = sortedNames(tools)
	for _, w := range Offers {
		if with[w] {
			p.With = append(p.With, w)
		}
	}
	p.finish()
	return p, nil
}

// PlanRemove plans taking out what setup made (for the tools named, or all of them): its sections, its import, the
// skill and the caitlyn MCP entries, keeping everything else in each file. The project file is configuration, not
// something setup owns, so it stays: caitlyn config unset --project removes its keys.
func PlanRemove(r *Request) (*Plan, error) {
	p := newPlan(r.Root)
	items, err := inventory(r.Root)
	if err != nil {
		return nil, err
	}
	only := map[string]bool{}
	for _, t := range r.Tools {
		only[t.Name] = true
		p.Tools = append(p.Tools, t.Name)
	}
	with := map[string]bool{}
	agentsGone := false
	for _, it := range items {
		if it.what == WithDefaults {
			continue
		}
		want := it.what
		if want == "import" {
			want = WithInstructions
		}
		if len(r.With) > 0 && !r.With[want] {
			continue
		}
		// The tools that read it: a file several read (AGENTS.md) goes only when every one of them is named
		readers := it.tools
		switch {
		case it.rel == agentsMD:
			readers = []string{"cursor", "codex"}
		case it.rel == claudeMD || it.what == WithSkill:
			readers = []string{"claude-code"}
		}
		if len(only) > 0 {
			named, all := false, true
			for _, t := range readers {
				named = named || only[t]
				all = all && only[t]
			}
			if !all {
				if named {
					p.skip(Skip{What: want, File: it.rel, Why: SkipShared, Detail: it.rel + " is also read by " + labels(toolsOf(readers, only)) + ": name it in --tools too to remove it."})
				}
				continue
			}
		}
		with[want] = true
		switch it.what {
		case WithInstructions:
			c, err := p.file(it.rel, WithInstructions)
			if err != nil {
				return nil, err
			}
			for _, t := range it.tools {
				c.tools[t] = true
			}
			if sec, ok := describe.FindSection(c.file.After); ok && sec.Stamped {
				c.file.After = describe.RemoveLines(c.file.After, sec.Start, sec.End)
				c.notes = append(c.notes, describe.SectionHeading+" removed")
			}
			if it.rel == agentsMD && strings.TrimSpace(c.file.After) == "" {
				agentsGone = true
			}
		case "import":
			removeImport(p, it)
		case WithSkill:
			for _, rel := range []string{skillDir + "/SKILL.md", skillDir + "/references/commands.md"} {
				c, err := p.file(rel, WithSkill)
				if err != nil {
					return nil, err
				}
				c.tools["claude-code"] = true
				c.Edited = it.edited
				c.group = WithSkill
			}
		case WithMCP:
			plan, why, err := describe.PlanMCPRemoval(it.client, r.Root)
			if err != nil {
				return nil, err
			}
			if plan == nil {
				p.skip(Skip{What: WithMCP, File: it.rel, Why: SkipNotOurs, Detail: "The " + describe.MCPServerName + " server was left as it was: " + why + "."})
				continue
			}
			c := &Change{file: plan.Change, File: it.rel, What: WithMCP, tools: map[string]bool{it.tools[0]: true}}
			c.notes = append(c.notes, `"`+describe.MCPServerName+`" server removed`)
			p.byFile[it.rel] = c
			p.Changes = append(p.Changes, c)
		}
	}
	if agentsGone {
		// CLAUDE.md mustn't import a file that is no longer there
		for _, it := range items {
			if it.what == "import" {
				removeImport(p, it)
			}
		}
	}
	// the files left with nothing in them go, as if setup had never written them
	for _, c := range p.Changes {
		if c.file.Exists && !c.file.Delete && strings.TrimSpace(c.file.After) == "" {
			c.file.After, c.file.Delete = "", true
		}
		if c.What == WithSkill {
			c.file.After, c.file.Delete = "", true
		}
	}
	for _, w := range Offers {
		if with[w] {
			p.With = append(p.With, w)
		}
	}
	p.finish()
	return p, nil
}

// toolsOf are the tools named in names that aren't in except.
func toolsOf(names []string, except map[string]bool) []*Tool {
	var out []*Tool
	for _, n := range names {
		if t := FindTool(n); t != nil && !except[n] {
			out = append(out, t)
		}
	}
	return out
}

func removeImport(p *Plan, it item) {
	c, err := p.file(it.rel, WithInstructions)
	if err != nil {
		return
	}
	c.tools["claude-code"] = true
	if s, e, ok := ourImport(c.file.After); ok {
		c.file.After = describe.RemoveLines(c.file.After, s, e)
		c.notes = append(c.notes, importLine+" removed")
	}
}
