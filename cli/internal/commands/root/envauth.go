package root

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/exitcode"
	"github.com/caitlyn-ai/sdk/go/core"
)

// envAuth signs in from environment variables only: the fallback until package auth registers the full provider
// (profiles, the keychain, browser and device sign-in).
type envAuth struct{}

func (envAuth) Auth(_ context.Context, f *cmdutil.Factory, _ cmdutil.AuthRequest) (core.Auth, *cmdutil.AuthInfo, error) {
	tok, id := f.IO.Getenv("CAITLYN_TOKEN"), f.IO.Getenv("CAITLYN_CLIENT_ID")
	switch {
	case tok != "" && id != "":
		return nil, nil, cmdutil.Usagef("CAITLYN_TOKEN and CAITLYN_CLIENT_ID are both set: keep one")
	case tok != "":
		return core.Token(tok), &cmdutil.AuthInfo{Mode: "token"}, nil
	case id != "":
		return core.ClientCredentials{ClientID: id, ClientSecret: f.IO.Getenv("CAITLYN_CLIENT_SECRET")}, &cmdutil.AuthInfo{Mode: "client-credentials"}, nil
	}
	e := &cmdutil.Error{Exit: exitcode.Auth, Code: "sign_in_required", Title: "Not signed in."}
	e.AddNext("caitlyn auth login", "sign in")
	return nil, nil, e
}

// jsonMarshal writes problem details without escaping <, > and &, which hints use (<etag>).
func jsonMarshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}
