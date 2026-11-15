// Command live runs the developer docs' Go examples (examples/go/conversations, documents and agents)
// against a real Caitlyn workspace, for scripts/examples-live.mjs through scripts/examples-live/go.sh. It reads
// CAITLYN_ENDPOINT, CAITLYN_WORKSPACE, CAITLYN_TOKEN, CAITLYN_AGENT_ID, CAITLYN_KNOWLEDGE_BASE_ID and
// CAITLYN_PUBLISH_AGENT_ID, and prints one line per check on standard output: `ok <check>`,
// `fail <check>: <why>`, or `skip <check>: <reason>` for a check the workspace's settings rule out. What the
// examples themselves print goes to standard error.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/caitlyn-ai/sdk/examples/go/conversations"
	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// report is where the check lines go; os.Stdout is pointed at standard error so the examples' output stays out
// of them.
var report = os.Stdout

func main() {
	os.Stdout = os.Stderr
	for _, k := range []string{"CAITLYN_ENDPOINT", "CAITLYN_WORKSPACE", "CAITLYN_TOKEN", "CAITLYN_AGENT_ID"} {
		if os.Getenv(k) == "" {
			fmt.Fprintf(os.Stderr, "live: set %s (scripts/examples-live.mjs)\n", k)
			os.Exit(2)
		}
	}
	client, err := caitlyn.NewClient(os.Getenv("CAITLYN_WORKSPACE"), caitlyn.Token(os.Getenv("CAITLYN_TOKEN")),
		caitlyn.WithEndpoint(os.Getenv("CAITLYN_ENDPOINT")))
	if err != nil {
		fmt.Fprintln(os.Stderr, "live:", err)
		os.Exit(2)
	}
	agentID := os.Getenv("CAITLYN_AGENT_ID")
	failed := false
	check := func(name string, timeout time.Duration, run func(ctx context.Context) error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		err := run(ctx)
		var skipped skip
		var denied *caitlyn.PermissionDeniedError
		switch {
		case errors.As(err, &skipped):
			fmt.Fprintf(report, "skip %s: %s\n", name, oneLine(err))
			return
		case errors.As(err, &denied):
			// Reported in the exact form the shared runner reads: it records this as `public role only` when
			// the run says the token has only the public role (CAITLYN_PUBLIC_ROLE_ONLY=1), and as a failure otherwise.
			failed = true
			fmt.Fprintf(report, "fail %s: 403 %s: %s\n", name, denied.Code, oneLine(errors.New(denied.Detail)))
			return
		case err != nil:
			failed = true
			fmt.Fprintf(report, "fail %s: %s\n", name, oneLine(err))
			return
		}
		fmt.Fprintf(report, "ok %s\n", name)
	}

	check("GetCaller", 30*time.Second, func(ctx context.Context) error {
		caller, err := conversations.GetCaller(ctx, client)
		if err == nil && caller.Organisation.ID == "" {
			err = errors.New("no organisation in the answer")
		}
		return err
	})
	check("GetAgentVersion", 30*time.Second, func(ctx context.Context) error {
		draft, err := conversations.GetAgentVersion(ctx, client, agentID)
		if err == nil && (draft.AgentID != agentID || draft.ETag == "") {
			err = fmt.Errorf("agent %q, ETag %q", draft.AgentID, draft.ETag)
		}
		return err
	})
	var conversationID string
	check("CreateConversation", 30*time.Second, func(ctx context.Context) error {
		conversation, err := conversations.CreateConversation(ctx, client, agentID)
		if err != nil {
			return err
		}
		if conversation.ID == "" || conversation.AgentID != agentID {
			return fmt.Errorf("conversation %q with agent %q", conversation.ID, conversation.AgentID)
		}
		conversationID = conversation.ID
		return nil
	})
	check("SendMessage", 3*time.Minute, func(ctx context.Context) error {
		if conversationID == "" {
			return errors.New("no conversation: CreateConversation failed")
		}
		answer, err := conversations.SendMessage(ctx, client, conversationID)
		if err == nil && (answer.ID == "" || answer.Text == "") {
			err = fmt.Errorf("an empty answer (%q)", answer.ID)
		}
		return err
	})
	check("WatchConversation", 3*time.Minute, func(ctx context.Context) error {
		if conversationID == "" {
			return errors.New("no conversation: CreateConversation failed")
		}
		// Ask a question once the watcher is listening, and read that answer's own stream to the end.
		watched := make(chan struct{})
		sent := make(chan error, 1)
		go func() {
			select {
			case <-watched:
			case <-ctx.Done():
				sent <- ctx.Err()
				return
			}
			stream, err := client.Conversations.Send(ctx, conversationID, &caitlyn.SendMessageInput{Message: "And full-time staff?"})
			if err != nil {
				sent <- err
				return
			}
			defer stream.Close()
			_, err = stream.FinalMessage()
			sent <- err
		}()
		watchCtx, cancelWatch := context.WithCancel(ctx)
		defer cancelWatch()
		go func() {
			// Watch has sent its request by the time it returns; give the server a moment to attach the watcher.
			time.Sleep(time.Second)
			close(watched)
		}()
		answer, err := conversations.WatchConversation(watchCtx, client, conversationID)
		if err != nil {
			return err
		}
		if answer.Text == "" {
			return errors.New("message.completed with an empty answer")
		}
		if err := <-sent; err != nil {
			return fmt.Errorf("the watched question failed: %w", err)
		}
		return nil
	})
	check("WatchWorkspaceEvents", time.Minute, func(ctx context.Context) error {
		created, err := conversations.WatchWorkspaceEvents(ctx, client, agentID)
		if err != nil {
			return err
		}
		if created.EventID() == "" {
			return errors.New("conversation.created without an event ID")
		}
		return nil
	})
	check("stream.reset", time.Minute, func(ctx context.Context) error {
		var first caitlyn.WorkspaceEvent
		stop := errors.New("stop")
		_, err := conversations.CarryOn(ctx, client, uuidV7(time.Now().Add(-48*time.Hour)), func(e caitlyn.WorkspaceEvent) error {
			first = e
			return stop
		})
		if !errors.Is(err, stop) {
			if err == nil {
				err = errors.New("the stream ended with no event")
			}
			return err
		}
		reset, ok := first.(*caitlyn.StreamReset)
		if !ok {
			return fmt.Errorf("the first event is %s, not stream.reset", first.EventType())
		}
		if reset.Cursor == "" || reset.Cursor != reset.EventID() {
			return fmt.Errorf("cursor %q, event ID %q", reset.Cursor, reset.EventID())
		}
		return nil
	})
	documentChecks(client, check)
	agentChecks(client, agentID, strings.TrimSpace(os.Getenv("CAITLYN_PUBLISH_AGENT_ID")), check) // empty means unset
	if failed {
		os.Exit(1)
	}
}

// skip is a check that cannot run against this workspace; it is reported as `skip <check>: <why>`. The runner
// accepts only reasons that start with "no knowledge base configured" or "publishing turned off" from a language;
// any other skip counts as a failure.
type skip string

func (s skip) Error() string { return string(s) }

// uuidV7 is a UUIDv7 for time t: the cursor format the workspace stream uses.
func uuidV7(t time.Time) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	ms := uint64(t.UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	b[6] = b[6]&0x0f | 0x70
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func oneLine(err error) string {
	s := err.Error()
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '\n' || r == '\r' {
			r = ' '
		}
		out = append(out, r)
	}
	return string(out)
}
