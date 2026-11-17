//! The code the developer docs show for agents, their draft, versions and live history, one region per job.
//! src/bin/examples_live.rs runs them against a real Caitlyn workspace (scripts/examples-live/rust.sh), and
//! scripts/test-rust.sh runs clippy over them.
use std::path::Path;

use caitlyn_sdk::scope::AgentScope;
use caitlyn_sdk::{
    AgentAvatarInput, AgentConfiguration, AgentGuidance, AgentMarkInput, AgentVersion,
    AvatarColour, Client, Error, HistoryEntry, PublishAgentVersionResult, UploadFile,
};

/// Makes an agent with its first instructions, and publishes it.
pub async fn publish_agent(client: &Client, instructions: &str) -> Result<AgentScope, Error> {
    // #region publish-agent
    let agent = client
        .agents()
        .create("HR assistant")
        .configuration(AgentConfiguration {
            guidance: Some(AgentGuidance {
                instructions: Some(instructions.into()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await?;
    // create returns the agent's scope: its draft is there at once.
    let published = agent.draft().publish().name("v1").await?;
    println!("{} live: {}", agent.id(), published.live.version);
    // #endregion
    Ok(agent.into_scope())
}

/// Points live at an earlier version again.
pub async fn roll_back(
    client: &Client,
    agent_id: &str,
) -> Result<PublishAgentVersionResult, Error> {
    // #region roll-back
    let published = client.agent(agent_id).version("v13").publish().await?;
    // Live points at v13 again; v13 itself is unchanged, and the history records the move as a rollback.
    println!(
        "live is {} ({})",
        published.live.version, published.history_entry.id
    );
    // #endregion
    Ok(published)
}

/// Changes the draft's instructions, keeps the draft as a named version, then lists the versions and live's history.
pub async fn draft_and_versions(
    client: &Client,
    agent_id: &str,
) -> Result<(AgentVersion, Vec<AgentVersion>, Vec<HistoryEntry>), Error> {
    // #region update-draft
    let agent = client.agent(agent_id);
    // If-Match is optional on the draft: set it to refuse the change if someone else changed the draft first.
    let draft = agent.draft().get().await?;
    agent
        .draft()
        .update()
        .guidance(AgentGuidance {
            instructions: Some(
                "Answer leave and pay questions. Quote the clause you relied on.".into(),
            ),
            ..Default::default()
        })
        .if_match(&draft.etag)
        .await?;
    // #endregion
    // #region save-draft
    let saved = agent
        .draft()
        .save(format!("checked-{}", draft.etag.len()))
        .note("Checked by HR")
        .await?;
    let versions = agent.versions().list().collect().await?;
    let history = agent.history().list().collect().await?;
    // #endregion
    Ok((saved, versions, history))
}

/// Gives an agent a picture: a PNG, JPEG or WebP image of at most 1 MB.
pub async fn avatar_picture(client: &Client, agent_id: &str, picture: &Path) -> Result<(), Error> {
    // #region avatar-picture
    let agent = client.agent(agent_id);
    let current = agent.get().await?;
    // The picture is uploaded first, reserved as an agent's avatar picture; its id is sent as pictureUploadId.
    let updated = agent
        .update()
        .avatar(AgentAvatarInput {
            colour: Some(AvatarColour::Sage),
            mark: Some(AgentMarkInput {
                picture: Some(UploadFile::from(picture)),
                ..Default::default()
            }),
            ..Default::default()
        })
        .if_match(&current.etag)
        .await?;
    // pictureUrl may stop working after a time: read the agent again for a fresh one.
    let url = updated
        .avatar
        .as_ref()
        .and_then(|a| a.mark.as_ref())
        .and_then(|m| m.picture_url.as_deref());
    println!("{} {url:?}", updated.id);
    // #endregion
    Ok(())
}

/// An agent's versions and live history, one region each, as the Change an agent safely guide shows them.
pub async fn versions_and_history(client: &Client, agent_id: &str) -> Result<(), Error> {
    let agent = client.agent(agent_id);
    // #region save-draft-version
    // Keeps the draft as a version; live is unchanged.
    let saved = agent
        .draft()
        .save("checked-2026-11")
        .note("Checked by HR")
        .await?;
    println!("{}", saved.name);
    // #endregion
    // #region list-versions
    let mut versions = agent.versions().list().items();
    while let Some(version) = versions.next().await {
        let version = version?;
        println!("{} {:?}", version.name, version.created_at);
    }
    // #endregion
    // #region publish-version
    // Points live at a version: a rollback when it was live before. If-Match on live is optional.
    let published = agent
        .version("checked-2026-11")
        .publish()
        .note("Back to the checked version")
        .await?;
    println!(
        "live is {} since {}",
        published.live.version, published.live.published_at
    );
    // #endregion
    // #region list-history
    let history = agent.history().list().collect().await?;
    for entry in &history {
        println!("{} {} {:?}", entry.id, entry.version, entry.kind);
    }
    // #endregion
    if let Some(first) = history.first() {
        // #region get-history
        let entry = agent.history_entry(&first.id).get().await?;
        println!("{entry:?}");
        // #endregion
    }
    // #region reset-draft
    let draft = agent.draft().get().await?;
    // the draft is live's configuration again
    agent.draft().reset("live").if_match(&draft.etag).await?;
    // #endregion
    // #region delete-version
    agent.version("checked-2026-11").delete().await?;
    // #endregion
    Ok(())
}
