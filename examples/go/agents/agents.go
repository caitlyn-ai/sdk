// Package agents holds the developer docs' Go code for changing an agent safely, one region each. The live
// examples (examples/go/live, run by scripts/examples-live/go.sh) call these functions against a real Caitlyn
// workspace, so the code on the pages is known to work. scripts/test-go.sh builds and vets it.
package agents

import (
	"context"
	"errors"
	"fmt"

	caitlyn "github.com/caitlyn-ai/caitlyn-go"
)

// UpdateDraft changes the draft's instructions, failing if someone else changed the draft since it was read.
func UpdateDraft(ctx context.Context, client *caitlyn.Client, agentID, instructions string) (*caitlyn.AgentVersion, error) {
	// #region update-draft
	// Read the draft for its ETag, then change only the fields you set
	draft, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
	if err != nil {
		return nil, err
	}
	updated, err := client.Agents.Versions.UpdateDraft(ctx, agentID, &caitlyn.UpdateDraftVersionInput{
		Instructions: caitlyn.Ptr(instructions),
	}, caitlyn.WithIfMatch(draft.ETag))
	var changed *caitlyn.PreconditionFailedError
	if errors.As(err, &changed) {
		return nil, fmt.Errorf("someone else changed the draft: read it again and reapply your change: %w", err)
	}
	if err != nil {
		return nil, err
	}
	fmt.Println(updated.ETag) // the new ETag, for the next change
	// #endregion
	return updated, nil
}

// PinDraft keeps a copy of the draft you tested as a named version.
func PinDraft(ctx context.Context, client *caitlyn.Client, agentID, name string) (*caitlyn.PinDraftVersionResult, error) {
	// #region pin-draft
	draft, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
	if err != nil {
		return nil, err
	}
	// Production does not change, and the draft carries on as before. If-Match pins only the draft you read.
	pinned, err := client.Agents.Versions.Pin(ctx, agentID, &caitlyn.PinDraftVersionInput{
		Name: name, // for example "november-release"
		Note: caitlyn.Ptr("Quotes the policy clause it relied on."),
	}, caitlyn.WithIfMatch(draft.ETag))
	if err != nil {
		return nil, err
	}
	fmt.Println(pinned.Name, pinned.CreatedAt)
	// #endregion
	return pinned, nil
}

// ListVersions lists an agent's versions.
func ListVersions(ctx context.Context, client *caitlyn.Client, agentID string) ([]caitlyn.AgentVersionSummary, error) {
	// #region list-versions
	var versions []caitlyn.AgentVersionSummary
	for version, err := range client.Agents.Versions.List(ctx, &caitlyn.ListAgentVersionsInput{AgentID: agentID}) {
		if err != nil {
			return nil, err
		}
		matches := version.MatchesProduction != nil && *version.MatchesProduction
		fmt.Println(version.Name, version.CreatedAt, matches)
		versions = append(versions, version)
	}
	// #endregion
	return versions, nil
}

// PublishVersion makes production a copy of a version, failing if production changed since it was read.
func PublishVersion(ctx context.Context, client *caitlyn.Client, agentID, version string) (*caitlyn.AgentVersion, error) {
	// #region publish-version
	// Production's ETag, so two publishes cannot overwrite each other
	production, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "production"})
	if err != nil {
		return nil, err
	}
	published, err := client.Agents.Versions.Publish(ctx, &caitlyn.PublishAgentVersionInput{
		AgentID: agentID,
		Version: version, // a version name; rolling back is publishing an earlier one
		Note:    caitlyn.Ptr("Answers leave questions with the clause it relied on."),
	}, caitlyn.WithIfMatch(production.ETag))
	var changed *caitlyn.PreconditionFailedError
	if errors.As(err, &changed) {
		return nil, fmt.Errorf("production changed since you read it: check what is live, then publish again: %w", err)
	}
	if err != nil {
		return nil, err
	}
	fmt.Println(published.Name, published.PublishedAt)
	// #endregion
	return published, nil
}

// ListProductionHistory lists what production was before each publish.
func ListProductionHistory(ctx context.Context, client *caitlyn.Client, agentID string) ([]caitlyn.ProductionHistorySummary, error) {
	// #region list-production-history
	// Newest first: each entry is what production was before a publish, and who replaced it when
	var entries []caitlyn.ProductionHistorySummary
	input := &caitlyn.ListProductionHistoryEntriesInput{AgentID: agentID}
	for entry, err := range client.Agents.ProductionHistory.List(ctx, input) {
		if err != nil {
			return nil, err
		}
		fmt.Println(entry.PublishedAt, entry.UnpublishedAt, entry.UnpublishedBy.DisplayName)
		entries = append(entries, entry)
	}
	// #endregion
	return entries, nil
}

// GetProductionHistory reads one production history entry, with the configuration production had.
func GetProductionHistory(ctx context.Context, client *caitlyn.Client, agentID, entryID string) (*caitlyn.ProductionHistoryEntry, error) {
	// #region get-production-history
	entry, err := client.Agents.ProductionHistory.Get(ctx, &caitlyn.GetProductionHistoryEntryInput{
		AgentID:        agentID,
		HistoryEntryID: entryID,
	})
	if err != nil {
		return nil, err
	}
	fmt.Println(entry.PublishedBy.DisplayName, entry.Configuration.Instructions)
	// #endregion
	return entry, nil
}

// ResetDraft makes the draft a copy of another version.
func ResetDraft(ctx context.Context, client *caitlyn.Client, agentID, from string) (*caitlyn.AgentVersion, error) {
	// #region reset-draft
	draft, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
	if err != nil {
		return nil, err
	}
	// The draft becomes a copy of from: a version name, or "production". Nothing else changes.
	reset, err := client.Agents.Versions.ResetDraft(ctx, agentID, &caitlyn.ResetDraftVersionInput{From: from},
		caitlyn.WithIfMatch(draft.ETag))
	if err != nil {
		return nil, err
	}
	fmt.Println(reset.ETag)
	// #endregion
	return reset, nil
}

// DeleteVersion deletes a named version.
func DeleteVersion(ctx context.Context, client *caitlyn.Client, agentID, name string) error {
	// #region delete-version
	// Production is its own copy, so deleting the version it came from does not change it
	_, err := client.Agents.Versions.Delete(ctx, &caitlyn.DeleteAgentVersionInput{AgentID: agentID, Version: name})
	if err != nil {
		return err
	}
	// #endregion
	return nil
}
