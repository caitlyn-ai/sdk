// Package ci detects a CI system (the CLI design, 15.1) and reports to it natively (15.4): collapsible sections,
// annotations, step summaries and output variables, through one Reporter per provider.
package ci

import "strings"

// Provider is a detected CI system.
type Provider struct {
	// Name is gitlab, github, buildkite, circleci, azure, jenkins, bitbucket, codebuild or generic; "" outside CI.
	Name string
	// PullRequest is true in a merge or pull request pipeline.
	PullRequest bool
	// Reason names the variable that decided it.
	Reason string
}

// In reports whether a CI system was detected.
func (p Provider) In() bool { return p.Name != "" }

// RendersANSI reports whether the provider's log shows 16-colour ANSI (15.2).
func (p Provider) RendersANSI() bool {
	switch p.Name {
	case "gitlab", "github", "buildkite", "azure":
		return true
	}
	return false
}

type rule struct {
	name, env string
	pr        func(look func(string) (string, bool)) bool
}

var rules = []rule{
	{"gitlab", "GITLAB_CI", func(l func(string) (string, bool)) bool { v, _ := l("CI_MERGE_REQUEST_IID"); return v != "" }},
	{"github", "GITHUB_ACTIONS", func(l func(string) (string, bool)) bool {
		v, _ := l("GITHUB_EVENT_NAME")
		return v == "pull_request" || v == "pull_request_target"
	}},
	{"buildkite", "BUILDKITE", func(l func(string) (string, bool)) bool {
		v, ok := l("BUILDKITE_PULL_REQUEST")
		return ok && v != "" && v != "false"
	}},
	{"circleci", "CIRCLECI", func(l func(string) (string, bool)) bool { v, _ := l("CIRCLE_PULL_REQUEST"); return v != "" }},
	{"azure", "TF_BUILD", func(l func(string) (string, bool)) bool { v, _ := l("BUILD_REASON"); return v == "PullRequest" }},
	{"bitbucket", "BITBUCKET_COMMIT", func(l func(string) (string, bool)) bool { v, _ := l("BITBUCKET_PR_ID"); return v != "" }},
	{"codebuild", "CODEBUILD_BUILD_ARN", func(l func(string) (string, bool)) bool {
		v, _ := l("CODEBUILD_WEBHOOK_EVENT")
		return strings.HasPrefix(v, "PULL_REQUEST")
	}},
}

// Detect reads the environment. CAITLYN_CI overrides it: a provider name, generic, or off. CI=false (or 0) turns
// detection off, as ci-info documents.
func Detect(look func(string) (string, bool)) Provider {
	if v, ok := look("CAITLYN_CI"); ok && v != "" {
		switch strings.ToLower(v) {
		case "off", "0", "false", "none":
			return Provider{Reason: "CAITLYN_CI=" + v}
		default:
			p := Provider{Name: strings.ToLower(v), Reason: "CAITLYN_CI"}
			for _, r := range rules {
				if r.name == p.Name {
					p.PullRequest = r.pr(look)
				}
			}
			return p
		}
	}
	if v, ok := look("CI"); ok && (v == "false" || v == "0") {
		return Provider{Reason: "CI=" + v}
	}
	for _, r := range rules {
		if v, ok := look(r.env); ok && v != "" && v != "false" {
			return Provider{Name: r.name, PullRequest: r.pr(look), Reason: r.env}
		}
	}
	if v, ok := look("JENKINS_URL"); ok && v != "" {
		if b, ok := look("BUILD_ID"); ok && b != "" {
			c, _ := look("CHANGE_ID")
			return Provider{Name: "jenkins", PullRequest: c != "", Reason: "JENKINS_URL"}
		}
	}
	if v, ok := look("CI"); ok && v != "" {
		return Provider{Name: "generic", Reason: "CI"}
	}
	return Provider{}
}
