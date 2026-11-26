package ci

import "testing"

func look(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestDetectEachProvider(t *testing.T) {
	cases := []struct {
		env  map[string]string
		name string
		pr   bool
	}{
		{map[string]string{"GITLAB_CI": "true", "CI_MERGE_REQUEST_IID": "4"}, "gitlab", true},
		{map[string]string{"GITLAB_CI": "true"}, "gitlab", false},
		{map[string]string{"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "pull_request"}, "github", true},
		{map[string]string{"BUILDKITE": "true", "BUILDKITE_PULL_REQUEST": "false"}, "buildkite", false},
		{map[string]string{"BUILDKITE": "true", "BUILDKITE_PULL_REQUEST": "12"}, "buildkite", true},
		{map[string]string{"CIRCLECI": "true", "CIRCLE_PULL_REQUEST": "https://x"}, "circleci", true},
		{map[string]string{"TF_BUILD": "True", "BUILD_REASON": "PullRequest"}, "azure", true},
		{map[string]string{"JENKINS_URL": "https://j", "BUILD_ID": "1", "CHANGE_ID": "7"}, "jenkins", true},
		{map[string]string{"BITBUCKET_COMMIT": "abc"}, "bitbucket", false},
		{map[string]string{"CODEBUILD_BUILD_ARN": "arn", "CODEBUILD_WEBHOOK_EVENT": "PULL_REQUEST_CREATED"}, "codebuild", true},
		{map[string]string{"CI": "true"}, "generic", false},
		{map[string]string{"CI": "false", "GITLAB_CI": "true"}, "", false},
		{map[string]string{"CAITLYN_CI": "off", "GITLAB_CI": "true"}, "", false},
		{map[string]string{"CAITLYN_CI": "github"}, "github", false},
		{map[string]string{}, "", false},
	}
	for _, c := range cases {
		got := Detect(look(c.env))
		if got.Name != c.name || got.PullRequest != c.pr {
			t.Errorf("%v: got %+v, want %s pr=%v", c.env, got, c.name, c.pr)
		}
	}
}
