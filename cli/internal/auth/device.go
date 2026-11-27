package auth

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/go/core"
)

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"

// deviceAuthorization is the device authorisation endpoint's answer (RFC 8628 3.2).
type deviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int64  `json:"expires_in"`
	Interval                int64  `json:"interval"`
}

// wait waits d, or until ctx is done: between device-flow polls, and between workload identity retries.
func wait(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// startDevice asks for a device code (RFC 8628 3.1).
func (c *oauthClient) startDevice(ctx context.Context, scopes []string) (*deviceAuthorization, error) {
	form := url.Values{"client_id": {ClientID}, "resource": {c.Resource}}
	if len(scopes) > 0 {
		form.Set("scope", strings.Join(scopes, " "))
	}
	var d deviceAuthorization
	if _, err := c.postForm(ctx, c.deviceURL(), form, &d); err != nil {
		var ae *core.AuthError
		if errors.As(err, &ae) && (ae.Status == 404 || ae.Code == "unsupported_grant_type" || ae.Code == "unauthorized_client") {
			e := &cmdutil.Error{Exit: exitcode.NotSupported, Code: "DEVICE_SIGN_IN_UNSUPPORTED", Cause: err,
				Title:  "This workspace doesn't offer device sign-in yet.",
				Detail: "Its release has no device authorisation endpoint for the Caitlyn CLI."}
			e.AddNext("caitlyn auth login", "sign in with the browser instead")
			return nil, e
		}
		return nil, err
	}
	if d.DeviceCode == "" || d.UserCode == "" || d.VerificationURI == "" {
		return nil, &core.AuthError{Code: "invalid_response", Message: "the device authorisation endpoint's answer is incomplete"}
	}
	if d.Interval <= 0 {
		d.Interval = 5
	}
	if d.ExpiresIn <= 0 {
		d.ExpiresIn = 600
	}
	return &d, nil
}

// pollDevice polls the token endpoint until the person approves or denies, or the code expires (RFC 8628 3.4, 3.5).
func (c *oauthClient) pollDevice(ctx context.Context, d *deviceAuthorization) (*granted, error) {
	interval := time.Duration(d.Interval) * time.Second
	deadline := c.Now().Add(time.Duration(d.ExpiresIn) * time.Second)
	form := url.Values{"grant_type": {deviceGrant}, "device_code": {d.DeviceCode}, "client_id": {ClientID}}
	for {
		if err := wait(ctx, interval); err != nil {
			return nil, err
		}
		g, err := c.token(ctx, form)
		if err == nil {
			return g, nil
		}
		var ae *core.AuthError
		if !errors.As(err, &ae) {
			return nil, err
		}
		switch ae.Code {
		case "authorization_pending":
		case "slow_down":
			// RFC 8628 3.5: add five seconds to this and every later interval
			interval += 5 * time.Second
		case "access_denied":
			e := &cmdutil.Error{Exit: exitcode.Auth, Code: "access_denied", Title: "Sign-in was denied.", Cause: err,
				Detail: "The request was declined on the approval page. If that wasn't you, someone may have sent you a code to approve: don't approve codes you didn't ask for."}
			e.AddNext("caitlyn auth login --device", "start again")
			return nil, e
		case "expired_token":
			e := &cmdutil.Error{Exit: exitcode.Auth, Code: "expired_token", Title: "The code expired before it was approved.", Cause: err}
			e.AddNext("caitlyn auth login --device", "get a new code")
			return nil, e
		default:
			return nil, err
		}
		if !c.Now().Before(deadline) {
			e := &cmdutil.Error{Exit: exitcode.Auth, Code: "expired_token", Title: "The code expired before it was approved."}
			e.AddNext("caitlyn auth login --device", "get a new code")
			return nil, e
		}
	}
}
