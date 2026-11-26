package textdiff

import "testing"

func TestUnified(t *testing.T) {
	cases := []struct {
		name, a, b       string
		created, deleted bool
		want             string
	}{
		{"same", "a\n", "a\n", false, false, ""},
		{"created", "", "a\nb\n", true, false, "--- /dev/null\n+++ b/f\n@@ -0,0 +1,2 @@\n+a\n+b\n"},
		{"deleted", "a\n", "", false, true, "--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n"},
		{"appended", "1\n2\n3\n4\n5\n", "1\n2\n3\n4\n5\n\nnew\n", false, false, "--- a/f\n+++ b/f\n@@ -3,3 +3,5 @@\n 3\n 4\n 5\n+\n+new\n"},
		{"two hunks", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n", "x\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\ny\n", false, false,
			"--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n-1\n+x\n 2\n 3\n 4\n@@ -9,4 +9,4 @@\n 9\n 10\n 11\n-12\n+y\n"},
	}
	for _, c := range cases {
		if got := Unified("f", c.a, c.b, c.created, c.deleted); got != c.want {
			t.Errorf("%s:\n%s\nwant:\n%s", c.name, got, c.want)
		}
	}
}

func TestCounts(t *testing.T) {
	if a, r := Counts("a\nb\nc\n", "a\nx\nc\nd\n"); a != 2 || r != 1 {
		t.Errorf("Counts = +%d -%d", a, r)
	}
}
