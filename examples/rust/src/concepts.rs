//! The code on the developer docs' Errors, Retries, Streaming, Pagination and Telemetry pages (docs/*.md), one
//! region each. scripts/test-rust.sh runs clippy over it.
use std::time::Duration;

use caitlyn_sdk::{Auth, Client, ConversationEvent, Error, GetAgentVersionInput, ListDocumentsInput, SendMessageInput};

const CONVERSATION_ID: &str = "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47";

/// Telling the errors apart.
pub async fn errors(client: &Client) -> Result<(), Error> {
    // #region errors
    let input = GetAgentVersionInput { agent_id: "GHT7YRWXPL".into(), version: "v99".into() };
    match client.versions().get(input).await {
        Ok(version) => println!("{}", version.name),
        Err(Error::NotFound(_)) => println!("No such version"),
        Err(Error::Validation(err)) => {
            for e in &err.errors {
                println!("{:?} {:?} {:?}", e.pointer, e.code, e.detail);
            }
        }
        Err(Error::Connection(err)) => println!("No response from Caitlyn: {err}"), // after the SDK's retries
        Err(err) => {
            // Any other error. code() is the stable product code; quote request_id() to support.
            println!("{:?} {:?} {:?}", err.status(), err.code(), err.request_id());
            return Err(err);
        }
    }
    // #endregion
    Ok(())
}

/// A client that tries harder.
pub fn retries() -> Result<Client, Box<dyn std::error::Error>> {
    // #region retries
    let patient = Client::builder("your-company.getcaitlyn.ai", Auth::token(std::env::var("CAITLYN_TOKEN")?))
        .max_attempts(5) // the first attempt included; default 3
        .max_retry_delay(Duration::from_secs(120)) // the longest Retry-After to wait for; default 60 s
        .build()?;
    // #endregion
    Ok(patient)
}

/// A client with a larger retry budget.
pub fn retry_budget() -> Result<Client, Box<dyn std::error::Error>> {
    // #region retry-budget
    let batch = Client::builder("your-company.getcaitlyn.ai", Auth::token(std::env::var("CAITLYN_TOKEN")?))
        .retry_budget(2000) // retry tokens shared by every call on this client; default 500, and 0 turns retries off
        .build()?;
    // #endregion
    Ok(batch)
}

/// Streaming an answer.
pub async fn streaming(client: &Client) -> Result<(), Error> {
    // #region streaming
    let input = SendMessageInput { message: "How much annual leave do part-time staff get?".into(), ..Default::default() };
    let mut stream = client.conversations().send(CONVERSATION_ID, input).await?;
    while let Some(event) = stream.next().await {
        match event? {
            ConversationEvent::TextDelta(delta) => print!("{}", delta.delta),
            ConversationEvent::CitationAdded(added) => {
                println!("\n[{}] {:?}", added.citation.number, added.citation.document_name)
            }
            _ => {}
        }
    }
    let answer = stream.final_message().await?; // the complete message, with its citations
    println!("{} {:?}", answer.id, stream.request_id());
    // #endregion
    Ok(())
}

/// Listing every document in a folder.
pub async fn pagination(client: &Client) -> Result<(), Error> {
    // #region pagination
    // Every document in the folder: the next page is fetched as the loop reaches it
    let input = ListDocumentsInput {
        knowledge_base_id: "KB4T7YQ2WL".into(),
        folder: Some("hr/".into()),
        limit: Some(100),
        ..Default::default()
    };
    let mut documents = client.documents().list(input.clone());
    while let Some(document) = documents.next().await {
        let document = document?;
        println!("{} {:?}", document.name, document.status);
    }

    // Or page by page
    let mut pages = client.documents().list_pages(input);
    while let Some(page) = pages.next().await {
        let page = page?;
        println!("{} {:?}", page.items.len(), page.next_cursor);
    }
    // #endregion
    Ok(())
}
