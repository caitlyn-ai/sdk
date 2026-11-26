package cmdutil

import (
	"strings"
	"testing"
)

func TestRedactBody(t *testing.T) {
	form := RedactBody([]byte("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=DEV123&client_id=caitlyn-cli&code=AUTH9&code_verifier=V"))
	for _, secret := range []string{"DEV123", "AUTH9", "=V"} {
		if strings.Contains(form, secret) {
			t.Errorf("form body still has %q: %s", secret, form)
		}
	}
	if !strings.Contains(form, "client_id=caitlyn-cli") {
		t.Errorf("a non-secret field was redacted: %s", form)
	}
	js := RedactBody([]byte(`{"clientSecret":"s1","nested":{"accessToken":"a1","Access-Token":"a2"},"name":"keep","items":[{"refresh_token":"r1"},{"refresh_token":"r2"}]}`))
	for _, secret := range []string{"s1", "a1", "a2", "r1", "r2"} {
		if strings.Contains(js, `"`+secret+`"`) {
			t.Errorf("JSON body still has %q: %s", secret, js)
		}
	}
	if !strings.Contains(js, `"name":"keep"`) {
		t.Errorf("a non-secret member was redacted: %s", js)
	}
}

func TestShownBodyRedactsBeforeCutting(t *testing.T) {
	pad := strings.Repeat("a", 8<<10-40) // the secret starts before the 8 KiB cut and ends after it
	body := []byte(`{"pad":"` + pad + `","clientSecret":"s3cr3t-value-that-straddles"}`)
	if got := shownBody(body); strings.Contains(got, "s3cr3t") {
		t.Fatalf("the secret's start was printed: …%s", got[len(got)-80:])
	}
}

func TestRedactHeaderBySecretName(t *testing.T) {
	for _, h := range []string{"X-Api-Key", "Api-Key", "X-Client-Secret", "X-Token"} {
		if got := RedactHeader(h, "k-123"); got != "[redacted]" {
			t.Errorf("%s: %q", h, got)
		}
	}
	if got := RedactHeader("Caitlyn-Request-Id", "01J"); got != "01J" {
		t.Errorf("an ordinary header was redacted: %q", got)
	}
}
