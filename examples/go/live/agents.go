package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	caitlyn "github.com/caitlyn-ai/caitlyn-go"
	"github.com/caitlyn-ai/caitlyn-go/examples/agents"
)

// agentChecks runs the docs' code in examples/go/agents on CAITLYN_AGENT_ID and leaves that agent as it found it:
// the draft's instructions are put back, the version the checks pin is deleted, and its production is not
// touched. PublishAgentVersion publishes only on publishAgentID (CAITLYN_PUBLISH_AGENT_ID), an agent the checks
// may publish, and the production history checks then read that agent's history.
func agentChecks(client *caitlyn.Client, agentID, publishAgentID string, check func(string, time.Duration, func(context.Context) error)) {
	check("UpdateDraftVersion", time.Minute, func(ctx context.Context) error {
		before, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
		if err != nil {
			return err
		}
		original := before.Configuration.Instructions
		marked := original + "\n\n(Checked by the Go SDK's examples at " + time.Now().UTC().Format(time.RFC3339) + ".)"
		updated, err := agents.UpdateDraft(ctx, client, agentID, marked)
		if err != nil {
			return err
		}
		// Put the instructions back, whatever the check finds.
		restored, restoreErr := client.Agents.Versions.UpdateDraft(ctx, agentID, &caitlyn.UpdateDraftVersionInput{
			Instructions: caitlyn.Ptr(original),
		}, caitlyn.WithIfMatch(updated.ETag))
		switch {
		case updated.Configuration.Instructions != marked:
			return errors.New("the draft's instructions did not change")
		case updated.ETag == "" || updated.ETag == before.ETag:
			return fmt.Errorf("ETag %q after the change, %q before", updated.ETag, before.ETag)
		case restoreErr != nil:
			return fmt.Errorf("could not put the draft back: %w", restoreErr)
		case restored.Configuration.Instructions != original:
			return errors.New("the draft was not put back")
		}
		return nil
	})

	// A version of the draft as it is now, for ListAgentVersions, ResetDraftVersion and DeleteAgentVersion.
	pinned := "go-sdk-check-" + unique()
	pinnedOK := false
	needsPin := func() error {
		if !pinnedOK {
			return errors.New("no pinned version: PinDraftVersion failed")
		}
		return nil
	}
	check("PinDraftVersion", time.Minute, func(ctx context.Context) error {
		version, err := agents.PinDraft(ctx, client, agentID, pinned)
		if err != nil {
			return err
		}
		if version.Name != pinned {
			return fmt.Errorf("pinned %q, want %q", version.Name, pinned)
		}
		pinnedOK = true
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
		if !slices.ContainsFunc(versions, func(v caitlyn.AgentVersionSummary) bool { return v.Name == pinned }) {
			return fmt.Errorf("%d versions, none named %s", len(versions), pinned)
		}
		return nil
	})
	check("PublishAgentVersion", 2*time.Minute, func(ctx context.Context) error {
		if publishAgentID == "" {
			return skip("publishing turned off: CAITLYN_PUBLISH_AGENT_ID is not set")
		}
		// Pin that agent's draft, publish the pinned version, then delete it: production keeps running what was published.
		name := "go-sdk-publish-" + unique()
		if _, err := agents.PinDraft(ctx, client, publishAgentID, name); err != nil {
			return fmt.Errorf("pin the draft to publish: %w", err)
		}
		published, err := agents.PublishVersion(ctx, client, publishAgentID, name)
		deleteErr := agents.DeleteVersion(ctx, client, publishAgentID, name)
		switch {
		case err != nil:
			return err
		case published.PublishedAt == nil:
			return errors.New("production has no publishedAt after the publish")
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
	check("ListProductionHistory", time.Minute, func(ctx context.Context) error {
		entries, err := agents.ListProductionHistory(ctx, client, historyAgent)
		if err != nil {
			return err
		}
		listedHistory = true
		if len(entries) > 0 {
			entryID = entries[0].ID
		}
		return nil
	})
	check("GetProductionHistory", 30*time.Second, func(ctx context.Context) error {
		if !listedHistory {
			return errors.New("no history listed: ListProductionHistory failed")
		}
		if publishAgentID == "" {
			// The entry read is the one PublishAgentVersion made on the publish agent (CONTRIBUTING.md).
			return skip("publishing turned off: no publish agent to read a production history entry from")
		}
		if entryID == "" {
			return fmt.Errorf("%s has no production history entry after PublishAgentVersion", historyAgent)
		}
		entry, err := agents.GetProductionHistory(ctx, client, historyAgent, entryID)
		if err == nil && entry.ID != entryID {
			err = fmt.Errorf("entry %q, want %q", entry.ID, entryID)
		}
		return err
	})
	check("ResetDraftVersion", time.Minute, func(ctx context.Context) error {
		if err := needsPin(); err != nil {
			return err
		}
		before, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
		if err != nil {
			return err
		}
		// The pinned version has the draft's configuration, so resetting from it leaves the draft's configuration as it was.
		reset, err := agents.ResetDraft(ctx, client, agentID, pinned)
		if err != nil {
			return err
		}
		if reset.ETag == "" || reset.Configuration.Instructions != before.Configuration.Instructions {
			return fmt.Errorf("ETag %q; instructions changed: %v", reset.ETag, reset.Configuration.Instructions != before.Configuration.Instructions)
		}
		return nil
	})
	check("DeleteAgentVersion", time.Minute, func(ctx context.Context) error {
		if err := needsPin(); err != nil {
			return err
		}
		if err := agents.DeleteVersion(ctx, client, agentID, pinned); err != nil {
			return err
		}
		_, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: pinned})
		var notFound *caitlyn.NotFoundError
		if !errors.As(err, &notFound) {
			return fmt.Errorf("after deleting %s, reading it gave %v, want NotFoundError", pinned, err)
		}
		return nil
	})
}
