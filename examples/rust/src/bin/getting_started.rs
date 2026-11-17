//! The developer docs' Getting started page (docs/getting-started.md) shows the first-call region.
// #region first-call
use caitlyn_sdk::{Auth, Client};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new(
        "your-company.getcaitlyn.ai",
        Auth::token(std::env::var("CAITLYN_TOKEN")?),
    )?;

    // Read the draft of an agent: its configuration and its ETag (draft.etag)
    let draft = client.agent("GHT7YRWXPL").draft().get().await?;
    println!(
        "{}",
        draft
            .configuration
            .as_ref()
            .and_then(|c| c.guidance.as_ref())
            .and_then(|g| g.instructions.as_deref())
            .unwrap_or_default()
    );
    Ok(())
}
// #endregion
