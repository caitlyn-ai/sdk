// Package agents holds the developer docs' Go code for agents, one region each: configuring and publishing one,
// rolling back, and the rest of an agent's versions. The live examples (examples/go/live, run by
// scripts/examples-live/go.sh) call these functions against a real Caitlyn workspace, so the code on the pages is known
// to work. scripts/test-go.sh builds and vets it.
package agents

import (
	"context"
	"errors"
	"fmt"

	caitlyn "github.com/caitlyn-ai/sdk/go"
)

// PublishAgent creates an agent with its first draft, then publishes the draft as v1 (spec job 6).
func PublishAgent(ctx context.Context, client *caitlyn.Client, instructions string) (*caitlyn.CreatedAgent, error) {
	// #region publish-agent
	agent, err := client.Agents.Create(ctx, &caitlyn.CreateAgentInput{
		Name:          "HR assistant",
		Configuration: &caitlyn.AgentConfiguration{Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr(instructions)}},
	})
	if err != nil {
		return nil, err
	}
	// agent is the new agent's scope, carrying the response: agent.Draft() is at hand, with no second lookup
	published, err := agent.Draft().Publish(ctx, &caitlyn.PublishAgentVersionInput{Name: caitlyn.Ptr("v1")})
	if err != nil {
		return nil, err
	}
	fmt.Println(agent.ID(), published.Live.Version) // live now points at v1
	// #endregion
	return agent, nil
}

// RollBack points live at an earlier version again (spec job 7).
func RollBack(ctx context.Context, client *caitlyn.Client, agentID string) (*caitlyn.PublishAgentVersionResult, error) {
	// #region roll-back
	// v13 itself is unchanged; the agent's history records the move as a rollback
	rolledBack, err := client.Agent(agentID).Version("v13").Publish(ctx, nil)
	if err != nil {
		return nil, err
	}
	fmt.Println(rolledBack.Live.Version, rolledBack.HistoryEntry.Kind)
	// #endregion
	return rolledBack, nil
}

// AvatarPicture creates an agent whose avatar is a picture from a file on disk.
func AvatarPicture(ctx context.Context, client *caitlyn.Client, path string) (*caitlyn.CreatedAgent, error) {
	// #region avatar-picture
	// A PNG, JPEG or WebP image of at most 1 MB. The SDK uploads it as an avatar picture, then creates the agent with
	// the upload's id in its place.
	agent, err := client.Agents.Create(ctx, &caitlyn.CreateAgentInput{
		Name: "HR assistant",
		Avatar: &caitlyn.AgentAvatarInput{
			Colour: caitlyn.Ptr(caitlyn.AvatarColourSage),
			Mark:   &caitlyn.AgentMarkInput{PictureFile: caitlyn.Path(path)},
		},
	})
	if err != nil {
		return nil, err
	}
	fmt.Println(agent.ID(), agent.Result.Name)
	// #endregion
	return agent, nil
}

// UpdateDraft changes the draft's instructions.
func UpdateDraft(ctx context.Context, client *caitlyn.Client, agentID, instructions string) (*caitlyn.AgentVersion, error) {
	// #region update-draft
	// Changes only the fields you set. If-Match is optional here: with it, a draft someone else changed since you read
	// it is refused with a *caitlyn.PreconditionFailedError.
	updated, err := client.Agent(agentID).Draft().Update(ctx, &caitlyn.UpdateDraftVersionInput{
		Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr(instructions)},
	})
	if err != nil {
		return nil, err
	}
	fmt.Println(updated.ETag) // the new ETag, for a change that must not overwrite another
	// #endregion
	return updated, nil
}

// SaveDraft keeps the draft you tested as a named version, without changing what is live.
func SaveDraft(ctx context.Context, client *caitlyn.Client, agentID, name string) (*caitlyn.AgentVersion, error) {
	// #region save-draft-version
	saved, err := client.Agent(agentID).Draft().Save(ctx, &caitlyn.SaveDraftVersionInput{
		Name: name, // for example "november-release"
		Note: caitlyn.Ptr("Quotes the policy clause it relied on."),
	})
	if err != nil {
		return nil, err
	}
	fmt.Println(saved.Name, saved.CreatedAt)
	// #endregion
	return saved, nil
}

// ListVersions lists an agent's versions.
func ListVersions(ctx context.Context, client *caitlyn.Client, agentID string) ([]caitlyn.AgentVersion, error) {
	// #region list-versions
	var versions []caitlyn.AgentVersion
	for version, err := range client.Agent(agentID).Versions.List(ctx, nil) {
		if err != nil {
			return nil, err
		}
		matches := version.MatchesLive != nil && *version.MatchesLive // the version agents run now
		fmt.Println(version.Name, version.CreatedAt, matches)
		versions = append(versions, version)
	}
	// #endregion
	return versions, nil
}

// PublishVersion makes a version the live one, failing if live moved since the caller looked.
func PublishVersion(ctx context.Context, client *caitlyn.Client, agentID, version, expectedLive string) (*caitlyn.PublishAgentVersionResult, error) {
	// #region publish-version
	published, err := client.Agent(agentID).Version(version).Publish(ctx, &caitlyn.PublishAgentVersionInput{
		ExpectedLive: caitlyn.Ptr(expectedLive), // refused if live is no longer this version
		Note:         caitlyn.Ptr("Answers leave questions with the clause it relied on."),
	})
	var changed *caitlyn.PreconditionFailedError
	if errors.As(err, &changed) {
		return nil, fmt.Errorf("the live version changed since you looked: check what is live, then publish again: %w", err)
	}
	if err != nil {
		return nil, err
	}
	fmt.Println(published.Live.Version, published.Live.PublishedAt)
	// #endregion
	return published, nil
}

// ListHistory lists each change to an agent's live version.
func ListHistory(ctx context.Context, client *caitlyn.Client, agentID string) ([]caitlyn.HistoryEntry, error) {
	// #region list-history
	// Newest first: each entry is a version that went live, the one it replaced, and who changed it when
	var entries []caitlyn.HistoryEntry
	for entry, err := range client.Agent(agentID).History.List(ctx, nil) {
		if err != nil {
			return nil, err
		}
		fmt.Println(entry.ChangedAt, entry.Kind, entry.Version, entry.ChangedBy.DisplayName)
		entries = append(entries, entry)
	}
	// #endregion
	return entries, nil
}

// GetHistory reads one history entry, with the configuration that went live.
func GetHistory(ctx context.Context, client *caitlyn.Client, agentID, entryID string) (*caitlyn.HistoryEntry, error) {
	// #region get-history
	entry, err := client.Agent(agentID).HistoryEntry(entryID).Get(ctx)
	if err != nil {
		return nil, err
	}
	fmt.Println(entry.ChangedBy.DisplayName, entry.Version)
	if entry.Configuration != nil && entry.Configuration.Guidance != nil && entry.Configuration.Guidance.Instructions != nil {
		fmt.Println(*entry.Configuration.Guidance.Instructions)
	}
	// #endregion
	return entry, nil
}

// ResetDraft starts the draft again from another version.
func ResetDraft(ctx context.Context, client *caitlyn.Client, agentID, from string) (*caitlyn.AgentVersion, error) {
	// #region reset-draft
	draft := client.Agent(agentID).Draft()
	current, err := draft.Get(ctx)
	if err != nil {
		return nil, err
	}
	// The draft starts again from the version in from: a version name, or "live". Nothing else changes.
	reset, err := draft.Reset(ctx, &caitlyn.ResetDraftVersionInput{From: from}, caitlyn.WithIfMatch(current.ETag))
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
	// A version live points at, or one live history names, is refused with a *caitlyn.ConflictError
	if _, err := client.Agent(agentID).Version(name).Delete(ctx); err != nil {
		return err
	}
	// #endregion
	return nil
}
