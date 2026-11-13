//! The developer docs' Getting started page (docs/getting-started.md) shows the first-call region.
// #region first-call
use caitlyn_sdk::{Auth, Client, GetAgentVersionInput};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new("your-company.getcaitlyn.ai", Auth::token(std::env::var("CAITLYN_TOKEN")?))?;

    // Read the draft of an agent: its configuration and its ETag
    let draft = client
        .versions()
        .get(GetAgentVersionInput { agent_id: "GHT7YRWXPL".into(), version: "draft".into() })
        .await?;
    println!("{}", draft.configuration.instructions);
    Ok(())
}
// #endregion
