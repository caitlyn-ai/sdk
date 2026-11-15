//! The code the developer docs show for agent versions and production history, one region each.
//! src/bin/examples_live.rs runs them against a real Caitlyn workspace (scripts/examples-live/rust.sh), and
//! scripts/test-rust.sh runs clippy over them.
use caitlyn_sdk::{
    AgentVersion, AgentVersionSummary, Client, DeleteAgentVersionInput, DeleteAgentVersionResult, Error, GetAgentVersionInput,
    GetProductionHistoryEntryInput, ListAgentVersionsInput, ListProductionHistoryEntriesInput, PinDraftVersionInput, PinDraftVersionResult,
    ProductionHistoryEntry, ProductionHistorySummary, PublishAgentVersionInput, ResetDraftVersionInput, UpdateDraftVersionInput,
};

/// Changes the draft's instructions, only if nobody changed the draft since it was read.
pub async fn update_draft(client: &Client, agent_id: &str, instructions: &str) -> Result<AgentVersion, Error> {
    // #region update-draft
    let draft = client
        .agents()
        .versions()
        .get(GetAgentVersionInput {
            agent_id: agent_id.into(),
            version: "draft".into(),
        })
        .await?;
    let input = UpdateDraftVersionInput {
        instructions: Some(instructions.into()),
        ..Default::default()
    };
    // If-Match: fails with Error::PreconditionFailed if the draft changed after it was read
    let updated = client
        .agents()
        .versions()
        .update_draft(agent_id, input)
        .if_match(&draft.etag)
        .await?;
    println!("draft now {}", updated.etag);
    // #endregion
    Ok(updated)
}

/// Keeps a copy of the draft you tested under a name, to publish later.
pub async fn pin_draft(client: &Client, agent_id: &str, draft_etag: &str, name: &str) -> Result<PinDraftVersionResult, Error> {
    // #region pin-draft
    let input = PinDraftVersionInput {
        name: name.into(),
        note: Some("Answers checked against the leave policy.".into()),
    };
    // If-Match pins only the draft you tested; without it, the draft as it is now is pinned
    let pinned = client.agents().versions().pin(agent_id, input).if_match(draft_etag).await?;
    println!("pinned {} at {}", pinned.name, pinned.created_at);
    // #endregion
    Ok(pinned)
}

/// The agent's named versions: every pinned or published version (the draft and production are not listed).
pub async fn list_versions(client: &Client, agent_id: &str) -> Result<Vec<AgentVersionSummary>, Error> {
    // #region list-versions
    let input = ListAgentVersionsInput {
        agent_id: agent_id.into(),
        ..Default::default()
    };
    let versions = client.agents().versions().list(input).collect().await?; // every page
    for v in &versions {
        println!("{} {:?} based on {:?}", v.name, v.source, v.based_on);
    }
    // #endregion
    Ok(versions)
}

/// Makes a pinned version (or the draft) the one that answers in production.
pub async fn publish_version(client: &Client, agent_id: &str, version: &str) -> Result<AgentVersion, Error> {
    // #region publish-version
    let production = client
        .agents()
        .versions()
        .get(GetAgentVersionInput {
            agent_id: agent_id.into(),
            version: "production".into(),
        })
        .await?;
    let input = PublishAgentVersionInput {
        agent_id: agent_id.into(),
        version: version.into(),
        name: None,
        note: Some("Approved for the November release.".into()),
    };
    // If-Match is production's ETag, so two publishes cannot overwrite each other
    let published = client.agents().versions().publish(input).if_match(&production.etag).await?;
    println!("production is now {} ({})", published.name, published.etag);
    // #endregion
    Ok(published)
}

/// What has answered in production, most recent first.
pub async fn list_production_history(client: &Client, agent_id: &str) -> Result<Vec<ProductionHistorySummary>, Error> {
    // #region list-production-history
    let input = ListProductionHistoryEntriesInput {
        agent_id: agent_id.into(),
        limit: Some(10),
        ..Default::default()
    };
    let page = client.agents().production_history().list_pages(input).next().await.transpose()?; // the latest ten
    let entries = page.map(|p| p.items).unwrap_or_default();
    for e in &entries {
        println!("{:?} from {} to {}", e.version_name, e.published_at, e.unpublished_at);
    }
    // #endregion
    Ok(entries)
}

/// One past production configuration, in full.
pub async fn get_production_history(client: &Client, agent_id: &str, entry_id: &str) -> Result<ProductionHistoryEntry, Error> {
    // #region get-production-history
    let input = GetProductionHistoryEntryInput {
        agent_id: agent_id.into(),
        history_entry_id: entry_id.into(),
    };
    let entry = client.agents().production_history().get(input).await?;
    println!(
        "{:?} answered until {}: {}",
        entry.version_name, entry.unpublished_at, entry.configuration.instructions
    );
    // #endregion
    Ok(entry)
}

/// Replaces the draft with a copy of another version.
pub async fn reset_draft(client: &Client, agent_id: &str, draft_etag: &str, from: &str) -> Result<AgentVersion, Error> {
    // #region reset-draft
    let input = ResetDraftVersionInput { from: from.into() }; // a version name, or production
    let draft = client.agents().versions().reset_draft(agent_id, input).if_match(draft_etag).await?;
    println!("draft reset from {from}: {}", draft.etag);
    // #endregion
    Ok(draft)
}

/// Deletes a pinned version that is not in production.
pub async fn delete_version(client: &Client, agent_id: &str, version: &str) -> Result<DeleteAgentVersionResult, Error> {
    // #region delete-version
    let input = DeleteAgentVersionInput {
        agent_id: agent_id.into(),
        version: version.into(),
    };
    let deleted = client.agents().versions().delete(input).await?;
    println!("deleted {version} ({:?})", deleted.request_id);
    // #endregion
    Ok(deleted)
}
