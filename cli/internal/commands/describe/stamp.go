package describe

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// StampTag opens every marker the CLI leaves in a file it writes into a project for AI coding tools, so the file
// says what made it, and caitlyn ai status and remove find their own work in a repository a teammate only cloned.
const StampTag = "caitlyn ai setup"

// Stamp is what made a file: the CLI's version, and the workspace it named ("" when it names none).
type Stamp struct {
	Version   string `json:"version"`
	Workspace string `json:"workspace,omitempty"`
}

// NewStamp is the stamp for this CLI's version (a development build's is "dev").
func NewStamp(version, workspace string) Stamp {
	if version == "" {
		version = "dev"
	}
	return Stamp{Version: version, Workspace: workspace}
}

// Text is the stamp's words: "caitlyn ai setup · caitlyn 0.12.4 · acme.caitlyn.ai".
func (s Stamp) Text() string {
	t := StampTag + " · caitlyn " + s.Version
	if s.Workspace != "" {
		t += " · " + s.Workspace
	}
	return t
}

// Comment is the stamp as a Markdown comment line, which the instructions section carries under its heading.
func (s Stamp) Comment() string { return "<!-- " + s.Text() + " -->" }

// ParseStamp reads a stamp's words, or a comment line holding them.
func ParseStamp(s string) (Stamp, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(s, "<!--"), "-->"))
	s = strings.Trim(s, `"`)
	parts := strings.Split(s, " · ")
	if len(parts) < 2 || parts[0] != StampTag || !strings.HasPrefix(parts[1], "caitlyn ") {
		return Stamp{}, false
	}
	st := Stamp{Version: strings.TrimPrefix(parts[1], "caitlyn ")}
	if len(parts) > 2 {
		st.Workspace = parts[2]
	}
	return st, true
}

// SectionHeading is the heading of the instructions section.
const SectionHeading = "## Caitlyn CLI"

// StampedSnippet is the instructions section with its stamp under the heading: what the CLI writes into a file.
func StampedSnippet(s Stamp) string {
	snippet := AgentsSnippet(s.Workspace)
	return strings.Replace(snippet, SectionHeading+"\n", SectionHeading+"\n"+s.Comment()+"\n", 1)
}

// Section is where a document's "## Caitlyn CLI" section is: its lines [Start, End), with End the next heading of
// the same or a higher level (or the end of the document), and the stamp under its heading, if it has one.
type Section struct {
	Start, End int
	Stamp      Stamp
	Stamped    bool
}

// FindSection finds the document's "## Caitlyn CLI" section, outside code fences.
func FindSection(doc string) (Section, bool) {
	lines := strings.Split(doc, "\n")
	sec := Section{Start: -1, End: len(lines)}
	fence := false
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			fence = !fence
		}
		if fence {
			continue
		}
		if sec.Start < 0 && strings.TrimSpace(l) == SectionHeading {
			sec.Start = i
			continue
		}
		if sec.Start >= 0 && (strings.HasPrefix(l, "## ") || strings.HasPrefix(l, "# ")) {
			sec.End = i
			break
		}
	}
	if sec.Start < 0 {
		return Section{}, false
	}
	// the stamp is the first non-blank line under the heading
	for i := sec.Start + 1; i < sec.End; i++ {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		sec.Stamp, sec.Stamped = ParseStamp(lines[i])
		break
	}
	return sec, true
}

// RemoveLines takes lines [start, end) out of a document, as if they had never been added: a block at the end goes
// with the blank line before it, and a document left with nothing in it is "".
func RemoveLines(doc string, start, end int) string {
	lines := strings.Split(doc, "\n")
	before := strings.Join(lines[:start], "\n")
	after := lines[end:]
	rest := strings.Join(after, "\n")
	if strings.TrimSpace(rest) == "" {
		if strings.TrimSpace(before) == "" {
			return ""
		}
		return strings.TrimRight(before, "\n") + "\n"
	}
	if before == "" {
		return strings.TrimLeft(rest, "\n")
	}
	return before + "\n" + rest
}

// The front matter keys that stamp the skill: the stamp, and a hash of its files as written, so an edited skill is
// asked about before it is replaced or removed.
const (
	SkillStampKey = "caitlyn-ai-setup"
	SkillHashKey  = "caitlyn-content-hash"
)

// StampSkill stamps the skill's SKILL.md in its front matter, under metadata (the field the skill format keeps for
// tools' own keys), with the stamp and the hash of both files.
func StampSkill(files []SkillFile, s Stamp) []SkillFile {
	out := append([]SkillFile(nil), files...)
	var skill, rest *SkillFile
	for i := range out {
		switch out[i].Path {
		case "SKILL.md":
			skill = &out[i]
		case "references/commands.md":
			rest = &out[i]
		}
	}
	if skill == nil {
		return out
	}
	other := ""
	if rest != nil {
		other = rest.Text
	}
	meta := "metadata:\n  " + SkillStampKey + ": \"" + s.Text() + "\"\n"
	unhashed := strings.Replace(skill.Text, "\n---\n", "\n"+meta+"---\n", 1)
	hash := SkillHash(unhashed, other)
	skill.Text = strings.Replace(unhashed, meta, meta+"  "+SkillHashKey+": \""+hash+"\"\n", 1)
	return out
}

// SkillHash is the hash a stamped skill carries: of SKILL.md without its hash line, and references/commands.md.
func SkillHash(skillMD, commandsMD string) string {
	var kept []string
	for _, l := range strings.Split(skillMD, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), SkillHashKey+":") {
			continue
		}
		kept = append(kept, l)
	}
	h := sha256.Sum256([]byte(strings.Join(kept, "\n") + "\x00" + commandsMD))
	return "sha256:" + hex.EncodeToString(h[:])
}

// SkillMark is what a SKILL.md says about itself: its stamp, the hash it carries, and whether its files still have
// that hash (Edited when they don't).
type SkillMark struct {
	Stamp  Stamp
	Hash   string
	Edited bool
}

// ReadSkillMark reads a SKILL.md's stamp from its front matter; ok is false when it has none (a skill the CLI didn't
// write, or one written before skills were stamped).
func ReadSkillMark(skillMD, commandsMD string) (SkillMark, bool) {
	if !strings.HasPrefix(skillMD, "---\n") {
		return SkillMark{}, false
	}
	end := strings.Index(skillMD[4:], "\n---\n")
	if end < 0 {
		return SkillMark{}, false
	}
	var m SkillMark
	found := false
	for _, l := range strings.Split(skillMD[4:4+end], "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(l), ":")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"`)
		switch k {
		case SkillStampKey:
			m.Stamp, found = ParseStamp(v)
		case SkillHashKey:
			m.Hash = v
		}
	}
	if !found {
		return SkillMark{}, false
	}
	m.Edited = m.Hash == "" || SkillHash(skillMD, commandsMD) != m.Hash
	return m, true
}
