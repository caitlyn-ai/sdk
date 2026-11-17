package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/caitlyn-ai/sdk/examples/go/agents"
	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// agentChecks runs the docs' code in examples/go/agents on CAITLYN_AGENT_ID and leaves that agent as it found it:
// the draft's instructions are put back, the version the checks pin is deleted, and its live version is not
// touched. PublishAgentVersion publishes only on publishAgentID (CAITLYN_PUBLISH_AGENT_ID), an agent the checks
// may publish, and the live history checks then read that agent's history.
func agentChecks(client *caitlyn.Client, agentID, publishAgentID string, check func(string, time.Duration, func(context.Context) error)) {
	check("UpdateDraftVersion", time.Minute, func(ctx context.Context) error {
		before, err := client.Agent(agentID).Draft().Get(ctx)
		if err != nil {
			return err
		}
		original := instructions(before.Configuration)
		marked := original + "\n\n(Checked by the Go SDK's examples at " + time.Now().UTC().Format(time.RFC3339) + ".)"
		updated, err := agents.UpdateDraft(ctx, client, agentID, marked)
		if err != nil {
			return err
		}
		// Put the instructions back, whatever the check finds.
		restored, restoreErr := client.Agent(agentID).Draft().Update(ctx, &caitlyn.UpdateDraftVersionInput{
			Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr(original)},
		}, caitlyn.WithIfMatch(updated.ETag))
		switch {
		case instructions(updated.Configuration) != marked:
			return errors.New("the draft's instructions did not change")
		case updated.ETag == "" || updated.ETag == before.ETag:
			return fmt.Errorf("ETag %q after the change, %q before", updated.ETag, before.ETag)
		case restoreErr != nil:
			return fmt.Errorf("could not put the draft back: %w", restoreErr)
		case instructions(restored.Configuration) != original:
			return errors.New("the draft was not put back")
		}
		return nil
	})

	// A version of the draft as it is now, for ListAgentVersions, ResetDraftVersion and DeleteAgentVersion.
	saved := "go-sdk-check-" + unique()
	savedOK := false
	needsPin := func() error {
		if !savedOK {
			return errors.New("no saved version: SaveDraftVersion failed")
		}
		return nil
	}
	check("SaveDraftVersion", time.Minute, func(ctx context.Context) error {
		version, err := agents.SaveDraft(ctx, client, agentID, saved)
		if err != nil {
			return err
		}
		if version.Name != saved {
			return fmt.Errorf("saved %q, want %q", version.Name, saved)
		}
		savedOK = true
		return nil
	})
	check("ListAgentVersions", time.Minute, func(ctx context.Context) error {
		if err := needsPin(); err != nil {
			return err
		}
		versions, err := agents.ListVersions(ctx, client, agentID)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(versions, func(v caitlyn.AgentVersion) bool { return v.Name == saved }) {
			return fmt.Errorf("%d versions, none named %s", len(versions), saved)
		}
		return nil
	})
	check("PublishAgentVersion", 2*time.Minute, func(ctx context.Context) error {
		if publishAgentID == "" {
			return skip("publishing turned off: CAITLYN_PUBLISH_AGENT_ID is not set")
		}
		// Save that agent's draft, publish the saved version, then delete it: the published version stays live.
		name := "go-sdk-publish-" + unique()
		if _, err := agents.SaveDraft(ctx, client, publishAgentID, name); err != nil {
			return fmt.Errorf("save the draft to publish: %w", err)
		}
		live, err := client.Agent(publishAgentID).Live().Get(ctx)
		if err != nil {
			return err
		}
		published, err := agents.PublishVersion(ctx, client, publishAgentID, name, live.Name)
		deleteErr := agents.DeleteVersion(ctx, client, publishAgentID, name)
		switch {
		case err != nil:
			return err
		case published.Live.Version != name:
			return fmt.Errorf("live is %s after the publish, want %s", published.Live.Version, name)
		case deleteErr != nil:
			return fmt.Errorf("could not delete the published version %s: %w", name, deleteErr)
		}
		return nil
	})
	historyAgent := agentID
	if publishAgentID != "" {
		historyAgent = publishAgentID // its history has at least the entry PublishAgentVersion made
	}
	var entryID string
	listedHistory := false
	check("ListHistoryEntries", time.Minute, func(ctx context.Context) error {
		entries, err := agents.ListHistory(ctx, client, historyAgent)
		if err != nil {
			return err
		}
		listedHistory = true
		if len(entries) > 0 {
			entryID = entries[0].ID
		}
		return nil
	})
	check("GetHistoryEntry", 30*time.Second, func(ctx context.Context) error {
		if !listedHistory {
			return errors.New("no history listed: ListHistoryEntries failed")
		}
		if publishAgentID == "" {
			// The entry read is the one PublishAgentVersion made on the publish agent (CONTRIBUTING.md).
			return skip("publishing turned off: no publish agent to read a history entry from")
		}
		if entryID == "" {
			return fmt.Errorf("%s has no history entry after PublishAgentVersion", historyAgent)
		}
		entry, err := agents.GetHistory(ctx, client, historyAgent, entryID)
		if err == nil && entry.ID != entryID {
			err = fmt.Errorf("entry %q, want %q", entry.ID, entryID)
		}
		return err
	})
	check("ResetDraftVersion", time.Minute, func(ctx context.Context) error {
		if err := needsPin(); err != nil {
			return err
		}
		before, err := client.Agent(agentID).Draft().Get(ctx)
		if err != nil {
			return err
		}
		// The saved version has the draft's configuration, so resetting from it leaves the draft's configuration as it was.
		reset, err := agents.ResetDraft(ctx, client, agentID, saved)
		if err != nil {
			return err
		}
		if changed := instructions(reset.Configuration) != instructions(before.Configuration); reset.ETag == "" || changed {
			return fmt.Errorf("ETag %q; instructions changed: %v", reset.ETag, changed)
		}
		return nil
	})
	check("DeleteAgentVersion", time.Minute, func(ctx context.Context) error {
		if err := needsPin(); err != nil {
			return err
		}
		if err := agents.DeleteVersion(ctx, client, agentID, saved); err != nil {
			return err
		}
		_, err := client.Agent(agentID).Version(saved).Get(ctx)
		var notFound *caitlyn.NotFoundError
		if !errors.As(err, &notFound) {
			return fmt.Errorf("after deleting %s, reading it gave %v, want NotFoundError", saved, err)
		}
		return nil
	})
}

// instructions is a configuration's guidance instructions, or "".
func instructions(c *caitlyn.AgentConfiguration) string {
	if c == nil || c.Guidance == nil || c.Guidance.Instructions == nil {
		return ""
	}
	return *c.Guidance.Instructions
}
