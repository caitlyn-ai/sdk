package ui_test

import (
	"fmt"
	"time"

	"testing"

	"github.com/caitlyn-ai/sdk/cli/internal/cmdutil"
	"github.com/caitlyn-ai/sdk/cli/internal/emblem"
	"github.com/caitlyn-ai/sdk/cli/internal/ui"
	"github.com/caitlyn-ai/sdk/cli/internal/ui/uitest"
)

// The rendered mock-ups of 12.10, each through a fake terminal at five profiles and three widths (17.2).

func TestGoldenList(t *testing.T) {
	uitest.Each(t, func(t *testing.T, p uitest.Profile, width int) {
		tm := uitest.New(t, p, width)
		u := tm.U
		rows := [][]ui.Cell{
			{{Text: "HR assistant", Role: ui.Strong}, {Text: "GHT7YRWXPL", Keep: true}, {Text: "v12"}, {Text: "changed", Role: ui.Warning}, {Text: "2 hours ago"}},
			{{Text: "Supplier contract reviewer", Role: ui.Strong}, {Text: "REVIEWER01", Keep: true}, {Text: "v7"}, {Text: "same as live"}, {Text: "3 days ago"}},
			{{Text: "Leave form helper", Role: ui.Strong}, {Text: "AGYFAMYTND", Keep: true}, {Text: "none", Role: ui.Muted}, {Text: "new"}, {Text: "5 minutes ago"}},
		}
		u.Table(tm.Out, true, []string{"Name", "ID", "Live", "Draft", "Updated"}, rows, "3 agents")
		tm.Golden(t, "list/"+t.Name()[len("TestGoldenList/"):])
	})
}

func TestGoldenDetail(t *testing.T) {
	uitest.Each(t, func(t *testing.T, p uitest.Profile, width int) {
		tm := uitest.New(t, p, width)
		u := tm.U
		dot := " " + u.G.Dot + " "
		u.Detail(tm.Out, "HR policies", "KB4T7YQ2WL", []ui.Group{
			{Rows: []ui.Row{
				{Key: "status", Value: u.S(ui.Success, u.G.Success) + " ready"},
				{Key: "description", Value: "Company HR policies and staff handbook."},
				{Key: "documents", Value: "214" + dot + "2 processing" + dot + u.S(ui.Error, "1 failed")},
				{Key: "search", Value: "layout-aware"},
				{Key: "updated", Value: "24 Nov 2026, 2:14 pm (Aroha Ngata)"},
			}},
			{Label: "access", Rows: []ui.Row{
				{Key: "readers", Value: "Everyone in HR, Managers"},
				{Key: "editors", Value: "Aroha Ngata"},
			}},
		}, "caitlyn kb documents list --kb KB4T7YQ2WL --filter 'status[eq]=failed'")
		tm.Golden(t, "detail/"+t.Name()[len("TestGoldenDetail/"):])
	})
}

func TestGoldenChatStreaming(t *testing.T) {
	ui.ChatTick = 0
	uitest.Each(t, func(t *testing.T, p uitest.Profile, width int) {
		tm := uitest.New(t, p, width)
		c := tm.U.NewChatStream(tm.F)
		c.Status("Searching HR policies")
		for _, d := range []string{"Yes. Up to **5 days** can be carried over ", "with your manager's approval [1]. ", "Anything above that must be taken by 31 March or paid out"} {
			c.Write(d)
		}
		c.Status("Checking the carry-over clause")
		c.Write(" [1].\n\nSee the policy for exceptions.\n")
		c.Finish([]ui.Source{{N: 1, Title: "Leave policy, page 4", URL: "https://intranet.example.govt.nz/policies/leave#carry-over"}},
			"HR assistant (live, v12) "+tm.U.G.Dot+" conversation 0193b1d4"+tm.U.G.Ellipsis+"7a10",
			`caitlyn chat --conversation 0193b1d4-5e2a-7c11-a9f0-2d6e8b4c7a10 "`+tm.U.G.Ellipsis+`"`)
		tm.Golden(t, "chat/"+t.Name()[len("TestGoldenChatStreaming/"):])
	})
}

func TestGoldenProgress(t *testing.T) {
	uitest.Each(t, func(t *testing.T, p uitest.Profile, width int) {
		tm := uitest.New(t, p, width)
		u := tm.U
		u.SuccessTimed("Hashed 214 files", 800*time.Millisecond)
		u.Successf("Planned: 3 new, 7 changed, 1 moved, 5 to remove, 198 unchanged")
		start := time.Date(2026, 11, 25, 9, 0, 0, 0, time.UTC)
		pr := u.NewProgress(tm.F, "Uploading", ui.Items, 10)
		pr.Now = func() time.Time { return start }
		pr.Phase("Uploading", 10)
		pr.ByteDone, pr.ByteTotal = 11_200_000, 18_400_000
		pr.Now = func() time.Time { return start.Add(30 * time.Second) }
		pr.Set(6)
		pr.Finish()
		u.SuccessTimed("Uploaded 10 files (18.4 MB)", 24*time.Second)
		u.SuccessTimed("Processed 10 documents", 112*time.Second)
		u.Successf("HR policies is in step with ./handbook")
		fmt.Fprintln(tm.Err, "  "+u.E(ui.Muted, "3 created · 7 new versions · 1 moved · 5 removed · 198 unchanged"))
		tm.Golden(t, "progress/"+t.Name()[len("TestGoldenProgress/"):])
	})
}

func TestGoldenDiff(t *testing.T) {
	uitest.Each(t, func(t *testing.T, p uitest.Profile, width int) {
		tm := uitest.New(t, p, width)
		tm.U.RenderDiff(tm.Out, ui.Diff{
			Title: "Plan for your-company.caitlyn.ai (profile default)",
			Resources: []ui.DiffResource{
				{Op: ui.DiffChanged, Kind: "agent", Name: "HR assistant", ID: "GHT7YRWXPL", Note: "draft", Members: []ui.DiffMember{
					{Op: ui.DiffChanged, Path: "guidance.instructions", Text: true,
						Before: "Answer leave and pay questions. Quote the policy clause you relied on.",
						After:  "Answer leave and pay questions. Quote the policy clause you relied on, and its number."},
					{Op: ui.DiffAdded, Path: "knowledgeBases[KB9M2QXR4T]", After: "maxQueries 2"},
					{Op: ui.DiffChanged, Path: "model", Before: "standard", After: "advanced"},
					{Op: ui.DiffRemoved, Path: "starters[2]", Before: "How do I book leave?"},
				}},
				{Op: ui.DiffAdded, Kind: "policy", Name: "Leave and pay", ID: "leave-and-pay"},
			},
			Unchanged: []string{"1 knowledge base set-up unchanged"},
			Summary:   "2 changes, 1 addition. Drafts only; live doesn't change.",
		})
		tm.Golden(t, "diff/"+t.Name()[len("TestGoldenDiff/"):])
	})
}

func TestGoldenError(t *testing.T) {
	uitest.Each(t, func(t *testing.T, p uitest.Profile, width int) {
		tm := uitest.New(t, p, width)
		e := &cmdutil.Error{Title: "The draft changed since you read it.", Status: 412, Code: "PRECONDITION_FAILED",
			Detail:    `Someone saved the draft of GHT7YRWXPL after you read it, so your change wasn't applied. Its ETag is now "draft-43"; you sent "draft-41".`,
			RequestID: "01JC9Q2W7R4M0H2T6N1S8V3B5X", Type: "https://build.caitlyn.ai/errors/PRECONDITION_FAILED"}
		e.AddNext("caitlyn agents draft edit GHT7YRWXPL", "read it again and re-apply your change")
		tm.U.RenderError(tm.Err, e)
		tm.Golden(t, "error/"+t.Name()[len("TestGoldenError/"):])
	})
}

func TestGoldenSignIn(t *testing.T) {
	uitest.Each(t, func(t *testing.T, p uitest.Profile, width int) {
		tm := uitest.New(t, p, width)
		u := tm.U
		fmt.Fprintln(tm.Err, u.E(ui.Strong, "Signing in to your-company.caitlyn.ai"))
		fmt.Fprintln(tm.Err)
		for _, l := range ui.Wrap(`Your browser is open at the sign-in page. Check that it names "Caitlyn CLI" and your-company.caitlyn.ai, then approve.`, tm.IO.ProseWidth()-2) {
			fmt.Fprintln(tm.Err, "  "+l)
		}
		fmt.Fprintln(tm.Err)
		fmt.Fprintln(tm.Err, "  Not opened? "+u.Err.Hyperlink("https://your-company.caitlyn.ai/api/oauth/authorize", "https://your-company.caitlyn.ai/api/oauth/authorize"))
		fmt.Fprintln(tm.Err)
		// The success screen as text alone: the fake terminal shows no images (the emblem has its own tests)
		emblem.SignedIn(tm.F, u, tm.Err, "Aroha Ngata", "aroha.ngata@example.govt.nz",
			"profile default "+u.G.Dot+" tokens in the macOS Keychain "+u.G.Dot+" scopes api:admin")
		tm.Golden(t, "signin/"+t.Name()[len("TestGoldenSignIn/"):])
	})
}

func TestGoldenEventsTail(t *testing.T) {
	uitest.Each(t, func(t *testing.T, p uitest.Profile, width int) {
		tm := uitest.New(t, p, width)
		u := tm.U
		at := func(h, m, s int) time.Time { return time.Date(2026, 11, 25, h, m, s, 0, time.Local) }
		run1, run2 := u.ShortID("3f9c2e7b-1a2b-4c3d-8e9f-0a1b2c3d5c60"), u.ShortID("7a21c9d0-4b5c-6d7e-8f90-a1b2c3d411ef")
		fmt.Fprintln(tm.Err, u.E(ui.Muted, "Listening for unattended_run.status_changed on REVIEWER01 "+u.G.Dot+" Ctrl-C to stop"))
		fmt.Fprintln(tm.Err)
		u.EventLine(tm.Out, at(14, 2, 11), ui.EventStarted, "started", run1, "REVIEWER01@live (v7)", "Aroha Ngata")
		u.EventLine(tm.Out, at(14, 8, 23), ui.EventSucceeded, "succeeded", run1, "6 m 12 s")
		u.EventLine(tm.Out, at(14, 11, 40), ui.EventStarted, "started", run2, "REVIEWER01@live (v7)", "an API client")
		u.EventLine(tm.Out, at(14, 12, 2), ui.EventFailed, "failed", run2, "ATTACHMENT_UNREADABLE")
		fmt.Fprintln(tm.Err, u.E(ui.Muted, "(reconnected)"))
		u.EventLine(tm.Out, at(14, 30, 5), ui.EventReset, "reset", "some events were missed; read runs again: caitlyn unattended-runs list --agent REVIEWER01")
		tm.Golden(t, "events/"+t.Name()[len("TestGoldenEventsTail/"):])
	})
}
