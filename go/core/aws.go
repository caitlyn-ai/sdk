package core

// The AWS half of the AWSIAM sign-in mode, with no AWS SDK: a small Signature Version 4 signer, the two
// credential sources AWS workloads use (environment variables, and the container credentials endpoint of
// ECS, Fargate and AgentCore runtimes), and one call, STS GetWebIdentityToken. Anything else (profiles,
// single sign-on, instance metadata) is reached by passing AWSIAM.Credentials.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AWSCredentials are AWS access keys, with a session token for temporary credentials.
type AWSCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	// Expiration is when temporary credentials stop working; zero when unknown.
	Expiration time.Time
}

// awsIdentityToken gets the JWT AWSIAM mode exchanges. Every failure is a sign-in error: the STS error code
// when STS refused, else aws_identity_failed.
func (s *AuthSession) awsIdentityToken(ctx context.Context, a AWSIAM) (string, error) {
	region := a.Region
	if region == "" {
		region = os.Getenv("AWS_REGION")
	}
	if region == "" {
		region = os.Getenv("AWS_DEFAULT_REGION")
	}
	if region == "" {
		return "", &AuthError{Code: "invalid_request", Message: "awsIam: set Region, or AWS_REGION, for the regional STS endpoint"}
	}
	fail := func(err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var ae *AuthError
		if errors.As(err, &ae) {
			return ae
		}
		return &AuthError{Code: "aws_identity_failed", Message: err.Error(), Cause: err}
	}
	var (
		creds AWSCredentials
		err   error
	)
	if a.Credentials != nil {
		creds, err = a.Credentials(ctx)
	} else {
		creds, err = s.defaultAWSCredentials(ctx)
	}
	if err != nil {
		return "", fail(err)
	}
	if creds.AccessKeyID == "" || creds.SecretAccessKey == "" {
		return "", fail(errors.New("awsIam: the credentials have no access key"))
	}
	audience := a.Audience
	if audience == "" {
		audience = s.resource
	}
	tok, err := s.getWebIdentityToken(ctx, a, region, audience, creds)
	if err != nil {
		return "", fail(err)
	}
	return tok, nil
}

// defaultAWSCredentials reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (with AWS_SESSION_TOKEN), else
// the container credentials endpoint.
func (s *AuthSession) defaultAWSCredentials(ctx context.Context) (AWSCredentials, error) {
	if id, secret := os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"); id != "" && secret != "" {
		return AWSCredentials{AccessKeyID: id, SecretAccessKey: secret, SessionToken: os.Getenv("AWS_SESSION_TOKEN")}, nil
	}
	u := os.Getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI")
	if rel := os.Getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"); u == "" && rel != "" {
		u = "http://169.254.170.2" + rel
	}
	if u == "" {
		return AWSCredentials{}, errors.New("awsIam: no AWS credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, run where the container credentials endpoint is set, or pass AWSIAM.Credentials")
	}
	token := os.Getenv("AWS_CONTAINER_AUTHORIZATION_TOKEN")
	if file := os.Getenv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"); token == "" && file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return AWSCredentials{}, fmt.Errorf("awsIam: read the container authorisation token: %w", err)
		}
		token = strings.TrimSpace(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return AWSCredentials{}, err
	}
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return AWSCredentials{}, fmt.Errorf("awsIam: the container credentials endpoint: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return AWSCredentials{}, fmt.Errorf("awsIam: the container credentials endpoint answered %d", resp.StatusCode)
	}
	var c struct {
		AccessKeyID     string `json:"AccessKeyId"`
		SecretAccessKey string `json:"SecretAccessKey"`
		Token           string `json:"Token"`
		Expiration      string `json:"Expiration"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
		return AWSCredentials{}, fmt.Errorf("awsIam: the container credentials endpoint: %w", err)
	}
	creds := AWSCredentials{AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey, SessionToken: c.Token}
	if t, err := time.Parse(time.RFC3339, c.Expiration); err == nil {
		creds.Expiration = t
	}
	return creds, nil
}

// getWebIdentityToken calls STS GetWebIdentityToken (outbound identity federation) and returns the JWT.
func (s *AuthSession) getWebIdentityToken(ctx context.Context, a AWSIAM, region, audience string, creds AWSCredentials) (string, error) {
	endpoint := a.STSEndpoint
	if endpoint == "" {
		endpoint = "https://sts." + region + ".amazonaws.com/"
	}
	duration := a.DurationSeconds
	if duration == 0 {
		duration = 300
	}
	alg := a.SigningAlgorithm
	if alg == "" {
		alg = "ES384"
	}
	body := url.Values{
		"Action":            {"GetWebIdentityToken"},
		"Version":           {"2011-06-15"},
		"Audience.member.1": {audience},
		"DurationSeconds":   {strconv.Itoa(duration)},
		"SigningAlgorithm":  {alg},
	}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
	SignV4(req, []byte(body), creds, region, "sts", time.Now())
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("awsIam: STS GetWebIdentityToken: %w", err)
	}
	defer resp.Body.Close()
	text := readAllString(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		code := xmlText(text, "Code")
		if code == "" {
			code = "http_" + strconv.Itoa(resp.StatusCode)
		}
		return "", &AuthError{Code: code, Message: "awsIam: STS GetWebIdentityToken failed: " + xmlText(text, "Message"), Status: resp.StatusCode}
	}
	tok := xmlText(text, "WebIdentityToken")
	if tok == "" {
		return "", errors.New("awsIam: STS answered without a WebIdentityToken")
	}
	return tok, nil
}

var xmlTags = map[string]*regexp.Regexp{
	"Code":             regexp.MustCompile(`<Code>([^<]*)</Code>`),
	"Message":          regexp.MustCompile(`<Message>([^<]*)</Message>`),
	"WebIdentityToken": regexp.MustCompile(`<WebIdentityToken>([^<]*)</WebIdentityToken>`),
}

// xmlText is the text of the first <tag> element (Code, Message or WebIdentityToken) in an STS response.
func xmlText(xml, tag string) string {
	if m := xmlTags[tag].FindStringSubmatch(xml); m != nil {
		return m[1]
	}
	return ""
}

// SignV4 signs req with AWS Signature Version 4 (header form): it sets X-Amz-Date, X-Amz-Content-Sha256,
// X-Amz-Security-Token for temporary credentials, and Authorization. body is the request body. Every header
// already on req is signed, with Host.
func SignV4(req *http.Request, body []byte, creds AWSCredentials, region, service string, now time.Time) {
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	payloadHash := sha256Hex(body)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if creds.SessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", creds.SessionToken)
	}
	headers := map[string]string{"host": req.URL.Host}
	for k, vs := range req.Header {
		headers[strings.ToLower(k)] = strings.Join(strings.Fields(strings.Join(vs, ",")), " ")
	}
	names := make([]string, 0, len(headers))
	for n := range headers {
		names = append(names, n)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, n := range names {
		canonHeaders.WriteString(n + ":" + headers[n] + "\n")
	}
	signed := strings.Join(names, ";")

	type pair struct{ k, v string }
	var pairs []pair
	for k, vs := range req.URL.Query() {
		for _, v := range vs {
			pairs = append(pairs, pair{awsEncode(k), awsEncode(v)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	query := make([]string, len(pairs))
	for i, p := range pairs {
		query[i] = p.k + "=" + p.v
	}
	segments := strings.Split(req.URL.Path, "/")
	for i, seg := range segments {
		segments[i] = awsEncode(seg)
	}
	path := strings.Join(segments, "/")
	if path == "" {
		path = "/"
	}

	canonical := strings.Join([]string{req.Method, path, strings.Join(query, "&"), canonHeaders.String(), signed, payloadHash}, "\n")
	scope := day + "/" + region + "/" + service + "/aws4_request"
	toSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonical))}, "\n")
	key := hmacSHA256([]byte("AWS4"+creds.SecretAccessKey), day)
	for _, part := range []string{region, service, "aws4_request"} {
		key = hmacSHA256(key, part)
	}
	signature := hex.EncodeToString(hmacSHA256(key, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+creds.AccessKeyID+"/"+scope+", SignedHeaders="+signed+", Signature="+signature)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// awsEncode is RFC 3986 encoding, as Signature Version 4 requires: everything but A-Z a-z 0-9 - _ . ~.
func awsEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
