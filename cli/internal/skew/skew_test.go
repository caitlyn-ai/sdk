package skew

import (
	"testing"
	"time"
)

func TestCompare(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{{"5.140.2", "5.144.0", -1}, {"5.144.0", "5.144.0", 0}, {"5.150.0", "5.144.9", 1}, {"next", "9.0.0", 1}, {"5.10.0", "5.9.0", 1}} {
		if got := Compare(c.a, c.b); got != c.want {
			t.Errorf("Compare(%s, %s) = %d", c.a, c.b, got)
		}
	}
}

func TestSaveLoad(t *testing.T) {
	dir := t.TempDir()
	if Load(dir, "default") != nil {
		t.Fatal("nothing saved yet")
	}
	Save(dir, "default", "5.140.2", time.Now())
	if s := Load(dir, "default"); s == nil || s.Version != "5.140.2" {
		t.Fatalf("got %+v", s)
	}
	if Load(dir, "other") != nil {
		t.Fatal("profiles are kept apart")
	}
}
