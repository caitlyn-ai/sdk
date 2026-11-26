package shellwords

import (
	"reflect"
	"testing"
)

func TestSplit(t *testing.T) {
	for in, want := range map[string][]string{
		`less -FRX`: {"less", "-FRX"},
		`"C:\Program Files\Microsoft VS Code\bin\code.cmd" --wait`: {`C:\Program Files\Microsoft VS Code\bin\code.cmd`, "--wait"},
		`'/Applications/My Editor.app/x' -w`:                       {"/Applications/My Editor.app/x", "-w"},
		`code --wait`:                                              {"code", "--wait"},
		`"say \"hi\""`:                                             {`say "hi"`},
		`   `:                                                      nil,
		``:                                                         nil,
	} {
		if got := Split(in); !reflect.DeepEqual(got, want) {
			t.Errorf("Split(%q) = %q, want %q", in, got, want)
		}
	}
}
