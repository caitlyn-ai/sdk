package spec

import "testing"

func TestMaturity(t *testing.T) {
	for in, want := range map[string]string{"beta": "preview", "preview": "preview", "experimental": "experimental", "ga": "", "stable": "", "internal": "", "": ""} {
		if got := Maturity(in); got != want {
			t.Errorf("Maturity(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"preview": "[Preview]", "experimental": "[Experimental]", "": ""} {
		if got := MaturityMarker(in); got != want {
			t.Errorf("MaturityMarker(%q) = %q, want %q", in, got, want)
		}
	}
}
