package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/go/core"
)

// Workload identity (15.3): a JWT from the CI system, exchanged by the SDK for a Caitlyn token. Every source is
// asked afresh at each sign-in, since the server accepts each JWT once and providers don't document lifetimes.

// The id_token_source values.
const (
	sourceAuto      = "auto"
	sourceEnv       = "env"
	sourceGitHub    = "github"
	sourceBuildkite = "buildkite"
)

// runCommand runs a program and returns its standard output and exit code; tests replace it.
var runCommand = func(ctx context.Context, name string, args ...string) (stdout []byte, code int, err error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err = cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		msg := strings.TrimSpace(errOut.String())
		if msg == "" {
			msg = ee.Error()
		}
		return out.Bytes(), ee.ExitCode(), errors.New(msg)
	}
	return out.Bytes(), 0, err
}

// idTokenSource returns the function the SDK calls for a JWT at each sign-in, and a description of where it comes
// from. getenv reads the run's environment; envVar is id_token_env (CAITLYN_ID_TOKEN unless the profile says).
func idTokenSource(source, envVar, audience string, getenv func(string) string, hc *http.Client) (func(context.Context) (string, error), string, error) {
	if source == "" {
		source = sourceAuto
	}
	if envVar == "" {
		envVar = "CAITLYN_ID_TOKEN"
	}
	if source == sourceAuto {
		switch {
		case getenv(envVar) != "":
			source = sourceEnv
		case getenv("ACTIONS_ID_TOKEN_REQUEST_URL") != "":
			source = sourceGitHub
		case getenv("BUILDKITE") != "" && getenv("BUILDKITE") != "false":
			source = sourceBuildkite
		default:
			e := cmdutil.Usagef("Workload identity needs an identity token, and none was found.")
			e.Exit = exitcode.Auth
			e.Code = "NO_IDENTITY_TOKEN"
			e.Detail = fmt.Sprintf("Set %s to your CI provider's OIDC token with the audience %s. In GitLab, use id_tokens; in GitHub Actions, grant permissions: id-token: write.", envVar, audience)
			e.Hint = &cmdutil.Hint{Docs: "https://build.caitlyn.ai/cli/ci/#signing-in-without-secrets"}
			return nil, "", e
		}
	}
	switch source {
	case sourceEnv:
		return func(context.Context) (string, error) {
			v := strings.TrimSpace(getenv(envVar))
			if v == "" {
				return "", &core.AuthError{Code: "invalid_request", Message: envVar + " is empty"}
			}
			return v, nil
		}, envVar, nil
	case sourceGitHub:
		return func(ctx context.Context) (string, error) {
			return githubIDToken(ctx, hc, getenv("ACTIONS_ID_TOKEN_REQUEST_URL"), getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN"), audience)
		}, "GitHub Actions OIDC", nil
	case sourceBuildkite:
		return func(ctx context.Context) (string, error) { return buildkiteIDToken(ctx, audience) }, "Buildkite OIDC", nil
	}
	return nil, "", cmdutil.Usagef("id_token_source %q is not one of auto, env, github or buildkite.", source)
}

// githubIDToken asks GitHub Actions for an OIDC token with the workspace audience (15.3).
func githubIDToken(ctx context.Context, hc *http.Client, requestURL, requestToken, audience string) (string, error) {
	if requestURL == "" || requestToken == "" {
		e := cmdutil.Usagef("GitHub Actions didn't provide an identity token request.")
		e.Exit = exitcode.Auth
		e.Code = "NO_IDENTITY_TOKEN"
		e.Detail = "ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN are set only for jobs with permissions: id-token: write."
		return "", e
	}
	sep := "&"
	if !strings.Contains(requestURL, "?") {
		sep = "?"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL+sep+"audience="+url.QueryEscape(audience), nil)
	if err != nil {
		return "", &core.AuthError{Code: "workload_identity_failed", Message: "ACTIONS_ID_TOKEN_REQUEST_URL is not a URL", Cause: err}
	}
	req.Header.Set("Authorization", "bearer "+requestToken)
	req.Header.Set("Accept", "application/json")
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "", &core.AuthError{Code: "workload_identity_failed", Message: "GitHub's identity token endpoint could not be reached: " + err.Error(), Cause: err}
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", &core.AuthError{Code: "workload_identity_failed", Status: resp.StatusCode,
			Message: fmt.Sprintf("GitHub refused the identity token request (HTTP %d): %s", resp.StatusCode, strings.TrimSpace(string(b)))}
	}
	var body struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(b, &body); err != nil || body.Value == "" {
		return "", &core.AuthError{Code: "workload_identity_failed", Message: "GitHub's identity token response has no value"}
	}
	return body.Value, nil
}

// buildkiteIDToken runs buildkite-agent for an OIDC token. Exit 77 means the request was refused: it is never retried.
// Other failures are retried twice.
func buildkiteIDToken(ctx context.Context, audience string) (string, error) {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			if err := wait(ctx, time.Duration(attempt)*time.Second); err != nil {
				return "", err
			}
		}
		out, code, err := runCommand(ctx, "buildkite-agent", "oidc", "request-token", "--audience", audience)
		if err == nil {
			tok := strings.TrimSpace(string(out))
			if tok != "" {
				return tok, nil
			}
			err = errors.New("it printed no token")
		}
		if code == 77 {
			return "", &core.AuthError{Code: "workload_identity_refused", Cause: err,
				Message: "Buildkite refused the identity token request (buildkite-agent exit 77): " + err.Error()}
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		last = err
	}
	return "", &core.AuthError{Code: "workload_identity_failed", Cause: last, Message: "buildkite-agent oidc request-token failed: " + last.Error()}
}
