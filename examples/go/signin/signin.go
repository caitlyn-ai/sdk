// Package signin creates a client in each sign-in mode. The developer docs' Authentication page
// (docs/authentication.md) shows each region; scripts/test-go.sh builds and vets it against the SDK.
package signin

import (
	"context"
	"os"

	caitlyn "github.com/caitlyn-ai/caitlyn-go"
)

func encryptedTokenStoreFor(userID string) caitlyn.TokenStore { panic("your own store") }

// Clients creates one client per mode.
func Clients(ctx context.Context, userID, sessionCookie string) error {
	// #region token
	script, err := caitlyn.NewClient("your-company.getcaitlyn.ai",
		caitlyn.Token(os.Getenv("CAITLYN_TOKEN"))) // a personal access token, cait-pat-…
	// #endregion
	if err != nil {
		return err
	}
	_ = script

	// #region client-credentials
	service, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.ClientCredentials{
		ClientID:     os.Getenv("CAITLYN_CLIENT_ID"),
		ClientSecret: os.Getenv("CAITLYN_CLIENT_SECRET"),
		Scopes:       []string{"api:read"},
	})
	// #endregion
	if err != nil {
		return err
	}
	_ = service

	// #region oauth
	asPerson, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.OAuth{
		ClientID:     os.Getenv("CAITLYN_CLIENT_ID"),
		ClientSecret: os.Getenv("CAITLYN_CLIENT_SECRET"), // a confidential client on a server
		RedirectURI:  "https://app.example.com/caitlyn/callback",
		Scopes:       []string{"api:write"},
		TokenStore:   encryptedTokenStoreFor(userID), // default: in memory
	})
	if err != nil {
		return err
	}

	// Send the person to start.URL, and keep start.State and start.CodeVerifier for the callback
	start, err := asPerson.Auth().AuthorizationURL(ctx, caitlyn.AuthorizationOptions{})
	// #endregion
	if err != nil {
		return err
	}

	code, returnedState := "", ""
	// #region oauth-callback
	_, err = asPerson.Auth().HandleCallback(ctx, caitlyn.Callback{
		Code:          code,
		State:         returnedState,
		ExpectedState: start.State,
		CodeVerifier:  start.CodeVerifier,
	})
	// #endregion
	if err != nil {
		return err
	}

	// #region aws-iam
	worker, err := caitlyn.NewClient("your-company.getcaitlyn.ai",
		caitlyn.AWSIAM{Region: "ap-southeast-2"}) // the workload's own AWS credentials
	// #endregion
	if err != nil {
		return err
	}
	_ = worker

	// #region workload-identity
	ciJob, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.WorkloadIdentity{
		Token: func(context.Context) (string, error) { return os.Getenv("CAITLYN_ID_TOKEN"), nil }, // GitLab CI id_tokens
	})
	// #endregion
	if err != nil {
		return err
	}
	_ = ciJob

	// #region session
	appPage, err := caitlyn.NewClient("your-company.getcaitlyn.ai",
		caitlyn.Session{Cookie: sessionCookie, Origin: "https://your-company.getcaitlyn.ai"})
	// #endregion
	if err != nil {
		return err
	}
	_ = appPage
	return nil
}
