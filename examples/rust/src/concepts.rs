//! The code on the developer docs' Errors, Retries, Streaming, Pagination and Telemetry pages (docs/*.md), one
//! region each. scripts/test-rust.sh runs clippy over it.
use std::time::Duration;

use caitlyn_sdk::{Auth, Client, ConversationEvent, Document, Error, ErrorCode};

const CONVERSATION_ID: &str = "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47";

/// Telling a missing version apart by its variant.
pub async fn errors_by_class(client: &Client) -> Result<(), Error> {
    // #region errors-class
    // The variant follows the HTTP status: a 404 is Error::NotFound, whichever call made it
    match client.agent("GHT7YRWXPL").version("v99").get().await {
        Ok(version) => println!("{}", version.name),
        Err(Error::NotFound(_)) => println!("No such version"),
        Err(err) => return Err(err),
    }
    // #endregion
    Ok(())
}

/// Matching an error on its code.
pub async fn errors_by_code(client: &Client) {
    // #region errors-code
    // Every error has a code(): match on it, and quote its request_id() to Caitlyn support
    if let Err(err) = client.agent("GHT7YRWXPL").version("v99").get().await {
        if err.code() == Some(ErrorCode::NOT_FOUND) {
            println!("No such version");
        }
        println!("{:?} {:?} {:?}", err.status(), err.code(), err.request_id());
    }
    // #endregion
}

/// Reading the members a refused request got wrong.
pub async fn errors_validation(client: &Client) {
    // #region errors-validation
    // A refused request names each member or parameter at fault
    if let Err(Error::Validation(err)) = client.knowledge_bases().list().limit(500).page().await {
        for e in &err.errors {
            println!(
                "{:?} {:?} {} {:?}",
                e.parameter, e.pointer, e.code, e.detail
            );
        }
    }
    // #endregion
}

/// Telling a call that got no response apart.
pub async fn errors_connection(client: &Client) {
    // #region errors-connection
    // No response at all, after the SDK's retries: the network error is kept as the source
    if let Err(Error::Connection(err)) = client.agent("GHT7YRWXPL").get().await {
        println!(
            "No response from Caitlyn: {:?}",
            std::error::Error::source(&err)
        );
    }
    // #endregion
}

/// Changing a knowledge base only if nobody else has since it was read.
pub async fn errors_if_match(client: &Client) -> Result<(), Error> {
    // #region errors-if-match
    // Change a thing only if nobody else has since you read it: send back the ETag you read
    let kb = client.knowledge_base("KB4T7YQ2WL");
    let current = kb.get().await?;
    match kb
        .update()
        .description("HR policies, 2026")
        .if_match(&current.etag)
        .await
    {
        Ok(_) => {}
        Err(Error::PreconditionFailed(_)) => {
            println!("It changed since you read it: read it again and reapply your change")
        }
        Err(err) => return Err(err),
    }
    // #endregion
    Ok(())
}

/// A client that names its application, CI system and agent in the user agent.
pub fn name_your_app() -> Result<Client, Box<dyn std::error::Error>> {
    // #region name-your-app
    let client = Client::builder(
        "your-company.getcaitlyn.ai",
        Auth::token(std::env::var("CAITLYN_TOKEN")?),
    )
    .app_id("release-bot#2.1.0") // app/release-bot#2.1.0
    .ci("gitlab") // ci/gitlab: the CI system it is running in
    .agent("claude-code") // agent/claude-code: the AI agent driving it
    .build()?;
    // #endregion
    Ok(client)
}

/// A client that tries harder.
pub fn retries() -> Result<Client, Box<dyn std::error::Error>> {
    // #region retries
    let patient = Client::builder(
        "your-company.caitlyn.ai",
        Auth::token(std::env::var("CAITLYN_TOKEN")?),
    )
    .max_attempts(5) // the first attempt included; default 3
    .max_retry_delay(Duration::from_secs(120)) // the longest Retry-After to wait for; default 60 s
    .build()?;
    // #endregion
    Ok(patient)
}

/// A client with a larger retry budget.
pub fn retry_budget() -> Result<Client, Box<dyn std::error::Error>> {
    // #region retry-budget
    let batch = Client::builder(
        "your-company.caitlyn.ai",
        Auth::token(std::env::var("CAITLYN_TOKEN")?),
    )
    .retry_budget(2000) // retry tokens shared by every call on this client; default 500, and 0 turns retries off
    .build()?;
    // #endregion
    Ok(batch)
}

/// Streaming an answer.
pub async fn streaming(client: &Client) -> Result<(), Error> {
    // #region streaming
    let conversation = client.conversation(CONVERSATION_ID);
    let mut stream = conversation
        .send("How much annual leave do part-time staff get?")
        .await?;
    while let Some(event) = stream.next().await {
        match event? {
            ConversationEvent::TextDelta(delta) => print!("{}", delta.delta),
            ConversationEvent::CitationAdded(added) => {
                println!(
                    "\n[{}] {:?}",
                    added.citation.number, added.citation.document_name
                )
            }
            _ => {}
        }
    }
    let answer = stream.final_message().await?; // the complete message, with its citations
    println!("{} {:?}", answer.id, stream.request_id());
    // #endregion
    Ok(())
}

/// Listing every document in a folder, one at a time.
pub async fn pagination_items(client: &Client) -> Result<(), Error> {
    // #region pagination-items
    // Every document in the folder, one at a time: the SDK fetches the next page when the loop reaches it
    let documents = client.knowledge_base("KB4T7YQ2WL").documents();
    let mut items = documents.list().folder("/policies/").limit(100).items();
    while let Some(document) = items.next().await {
        let document = document?;
        println!("{} {:?}", document.name, document.status);
        if document.name == "leave-policy.pdf" {
            break; // stops here: no further page is requested
        }
    }
    // #endregion
    Ok(())
}

/// Reading every page of a folder's documents in turn.
pub async fn pagination_pages(client: &Client) -> Result<(), Error> {
    // #region pagination-pages
    // Every page in turn, each with its items and next_cursor: for work done a batch at a time
    let documents = client.knowledge_base("KB4T7YQ2WL").documents();
    let mut pages = documents.list().folder("/policies/").limit(100).pages();
    while let Some(page) = pages.next().await {
        let page = page?;
        println!(
            "{} documents; more to come: {}",
            page.items.len(),
            page.has_next_page()
        );
    }
    // #endregion
    Ok(())
}

/// Reading one page of a folder's documents.
pub async fn pagination_page(client: &Client) -> Result<(), Error> {
    // #region pagination-page
    // One page, in exactly one request: the first 25 documents
    let documents = client.knowledge_base("KB4T7YQ2WL").documents();
    let page = documents
        .list()
        .folder("/policies/")
        .limit(25)
        .page()
        .await?;
    for document in &page.items {
        println!("{}", document.name);
    }
    println!("{:?}", page.next_cursor); // None on the last page
                                        // #endregion
    Ok(())
}

/// Showing a page and a Next button, and reading the next page when it is clicked.
pub async fn pagination_next_page(client: &Client) -> Result<(), Error> {
    let render = |items: &[Document]| println!("{}", items.len());
    // #region pagination-has-next-page
    // Show the first page, and a "Next" button only when another page follows: knowing that takes no request
    let documents = client.knowledge_base("KB4T7YQ2WL").documents();
    let mut page = documents
        .list()
        .folder("/policies/")
        .limit(25)
        .page()
        .await?;
    render(&page.items);
    let mut next_button_hidden = !page.has_next_page();
    // #endregion
    // #region pagination-next-page
    // When the "Next" button is clicked: one request, for the page after the one shown
    if let Some(next) = page.next_page().await? {
        // None after the last page
        page = next;
        render(&page.items);
        next_button_hidden = !page.has_next_page();
    }
    // #endregion
    println!("{next_button_hidden}");
    Ok(())
}

/// Carrying on from a saved cursor.
pub async fn pagination_cursor(client: &Client, cursor: Option<String>) -> Result<(), Error> {
    // #region pagination-cursor
    // Carry on from a position saved earlier (a link, a reload): the same input, and the cursor the page gave
    let documents = client.knowledge_base("KB4T7YQ2WL").documents();
    let mut list = documents.list().folder("/policies/").limit(25);
    if let Some(cursor) = cursor {
        list = list.cursor(cursor);
    }
    let page = list.page().await?;
    println!("{} {:?}", page.items.len(), page.next_cursor); // save page.next_cursor to carry on from here next time
                                                             // #endregion
    Ok(())
}
