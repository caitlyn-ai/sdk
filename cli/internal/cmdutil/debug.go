package cmdutil

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/caitlyn-ai/sdk/cli/internal/iostreams"
)

// DebugTransport prints each request's method, URL, status, timing and request ID on stderr (--debug), and with
// Bodies the bodies too (--debug=body). Authorization, cookies and presigned URLs' query strings are always
// redacted (the CLI design, section 9).
type DebugTransport struct {
	IO     *iostreams.IOStreams
	Bodies bool
	Base   http.RoundTripper
}

// RoundTrip sends the request and logs it.
func (t *DebugTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	start := time.Now()
	fmt.Fprintf(t.IO.ErrOut, "debug: → %s %s\n", req.Method, RedactURL(req.URL))
	for k, vs := range req.Header {
		for _, v := range vs {
			fmt.Fprintf(t.IO.ErrOut, "debug:   %s: %s\n", k, RedactHeader(k, v))
		}
	}
	if t.Bodies && req.Body != nil && req.GetBody != nil {
		if rc, err := req.GetBody(); err == nil {
			b, _ := io.ReadAll(io.LimitReader(rc, 1<<20))
			rc.Close()
			if isText(req.Header.Get("Content-Type")) {
				fmt.Fprintf(t.IO.ErrOut, "debug:   body: %s\n", shownBody(b))
			} else {
				fmt.Fprintf(t.IO.ErrOut, "debug:   body: (%s, not shown)\n", req.Header.Get("Content-Type"))
			}
		}
	}
	resp, err := base.RoundTrip(req)
	took := time.Since(start).Round(time.Millisecond)
	if err != nil {
		fmt.Fprintf(t.IO.ErrOut, "debug: ✗ %s after %s\n", err, took)
		return nil, err
	}
	fmt.Fprintf(t.IO.ErrOut, "debug: ← %d in %s", resp.StatusCode, took)
	if id := resp.Header.Get("Caitlyn-Request-Id"); id != "" {
		fmt.Fprintf(t.IO.ErrOut, " · request %s", id)
	}
	if v := resp.Header.Get("Caitlyn-Api-Version"); v != "" {
		fmt.Fprintf(t.IO.ErrOut, " · Caitlyn %s", v)
	}
	fmt.Fprintln(t.IO.ErrOut)
	if t.Bodies && resp.Body != nil && isText(resp.Header.Get("Content-Type")) && !strings.Contains(resp.Header.Get("Content-Type"), "event-stream") {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		resp.Body = io.NopCloser(bytes.NewReader(b))
		fmt.Fprintf(t.IO.ErrOut, "debug:   body: %s\n", shownBody(b))
	}
	return resp, nil
}

// shownBody redacts a body, then cuts it to 8 KiB: cut first, a secret straddling the cut would lose its closing
// quote, escape the redaction and print its start.
func shownBody(b []byte) string {
	s := RedactBody(b)
	if len(s) > 8<<10 {
		s = s[:8<<10] + " …"
	}
	return s
}

func isText(ct string) bool {
	return ct == "" || strings.Contains(ct, "json") || strings.HasPrefix(ct, "text/") || strings.Contains(ct, "x-www-form-urlencoded")
}

// RedactHeader hides credentials in a header's value.
func RedactHeader(name, value string) string {
	switch strings.ToLower(name) {
	case "authorization":
		if i := strings.IndexByte(value, ' '); i > 0 {
			return value[:i] + " [redacted]"
		}
		return "[redacted]"
	case "cookie", "set-cookie", "x-amz-security-token":
		return "[redacted]"
	}
	// a header named like a secret (caitlyn api -H "X-Api-Key: …"): its name, without an X- prefix, as a body member
	if secretKey(strings.TrimPrefix(strings.ToLower(name), "x-")) {
		return "[redacted]"
	}
	return value
}

// RedactURL hides a presigned URL's signature: any query string carrying X-Amz-* or Signature parameters.
func RedactURL(u *url.URL) string {
	if u == nil {
		return ""
	}
	q := u.Query()
	presigned := false
	for k := range q {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-amz-") || lk == "signature" || lk == "sig" || lk == "token" {
			presigned = true
		}
	}
	if !presigned {
		return u.String()
	}
	c := *u
	c.RawQuery = "[redacted]"
	return c.String()
}

// secretKeys are the member and form-field names whose values are redacted, compared lower-case with '_' and '-'
// removed, so access_token, accessToken and Access-Token all match.
var secretKeys = map[string]bool{
	"accesstoken": true, "refreshtoken": true, "clientsecret": true, "password": true, "secret": true, "token": true,
	"idtoken": true, "subjecttoken": true, "codeverifier": true, "devicecode": true, "code": true, "usercode": true,
	"assertion": true, "clientassertion": true, "apikey": true, "authorization": true, "signingsecret": true,
}

func secretKey(k string) bool {
	return secretKeys[strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(k))]
}

var (
	formField  = regexp.MustCompile(`(^|&)([^=&]+)=([^&]*)`)
	jsonMember = regexp.MustCompile(`"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)"`)
)

// RedactBody hides secret-looking JSON members and form fields in a logged body: every occurrence, whatever the
// name's case or separators.
func RedactBody(b []byte) string {
	s := string(b)
	s = jsonMember.ReplaceAllStringFunc(s, func(m string) string {
		p := jsonMember.FindStringSubmatch(m)
		if !secretKey(p[1]) {
			return m
		}
		return `"` + p[1] + `"` + p[2] + `"[redacted]"`
	})
	if !strings.HasPrefix(strings.TrimSpace(s), "{") && !strings.HasPrefix(strings.TrimSpace(s), "[") {
		s = formField.ReplaceAllStringFunc(s, func(m string) string {
			p := formField.FindStringSubmatch(m)
			if !secretKey(p[2]) {
				return m
			}
			return p[1] + p[2] + "=[redacted]"
		})
	}
	return s
}
