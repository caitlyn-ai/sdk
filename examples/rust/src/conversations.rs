//! The code the developer docs show for conversations and the workspace's events, one region each.
//! src/bin/examples_live.rs runs them against a real Caitlyn server (scripts/examples-live/rust.sh), and
//! scripts/test-rust.sh runs clippy over them.
use caitlyn_sdk::scope::ConversationScope;
use caitlyn_sdk::{
    Attachment, Caller, Client, ConversationCreatedEvent, ConversationEvent, Error, Message,
    WorkspaceEvent,
};

/// Who the credential belongs to.
pub async fn get_caller(client: &Client) -> Result<Caller, Error> {
    // #region get-caller
    let caller = client.me().await?;
    println!(
        "{} ({:?}) in {}",
        caller.display_name, caller.credential, caller.organisation.name
    );
    println!("scopes: {}", caller.scopes.join(" "));
    // #endregion
    Ok(caller)
}

/// Starts a conversation with an agent's live version and reads the answer as it is written.
pub async fn chat(client: &Client, agent_id: &str) -> Result<(ConversationScope, Message), Error> {
    // #region chat
    let conversation = client
        .agent(agent_id)
        .live()
        .conversations()
        .create()
        .await?;
    // The message is sent when the call is awaited; the stream may be read or dropped.
    let mut answer = conversation
        .send("How much leave do part-time staff get?")
        .await?
        .text();
    while let Some(text) = answer.next().await {
        print!("{}", text?);
    }
    let message = answer.final_message().await?; // the complete message, with its citations
    println!();
    // #endregion
    Ok((conversation.into_scope(), message))
}

/// Follows an answer being written, after a page reload: only the conversation's identifier is needed.
pub async fn watch_conversation(
    client: &Client,
    conversation_id: &str,
) -> Result<Option<ConversationEvent>, Error> {
    // #region watch-conversation
    // The answer being written, if there is one, then every answer after it, until you close the stream. The SDK
    // reconnects by itself.
    let mut stream = client.conversation(conversation_id).watch().await?;
    let mut last = None;
    while let Some(event) = stream.next().await {
        match event? {
            ConversationEvent::TextDelta(delta) => print!("{}", delta.delta),
            ConversationEvent::MessageCompleted(done) => {
                println!("\n{} is complete", done.message.id);
                last = Some(ConversationEvent::MessageCompleted(done));
                break; // a watch does not end by itself: stop at the event you wanted, and dropping it closes it
            }
            ConversationEvent::MessageFailed(failed) => {
                println!(
                    "\nthe answer failed: {} {} (request {})",
                    failed.code, failed.title, failed.request_id
                );
                last = Some(ConversationEvent::MessageFailed(failed));
                break;
            }
            _ => {}
        }
    }
    // #endregion
    Ok(last)
}

/// Waits for the workspace's `conversation.created` for a conversation this call starts.
pub async fn watch_workspace_events(
    client: &Client,
    agent_id: &str,
) -> Result<Option<ConversationCreatedEvent>, Error> {
    // #region watch-workspace-events
    // Open the stream first, so it sees what the next call causes; without `after` it starts now.
    let mut events = client
        .events()
        .watch()
        .types(["conversation.created"])
        .await?;
    let conversation = client
        .agent(agent_id)
        .draft()
        .conversations()
        .create()
        .await?;
    let mut seen = None;
    while let Some(event) = events.next().await {
        match event? {
            WorkspaceEvent::ConversationCreated(created)
                if created.data.id == conversation.id() =>
            {
                // Its event_id is a cursor: send it back as `after` to carry on from here.
                println!(
                    "{} created by a {:?} caller",
                    created.data.id, created.actor.r#type
                );
                seen = Some(created);
                break; // dropping the stream closes it
            }
            WorkspaceEvent::StreamReset(reset) => {
                println!("events were missed; carry on from {}", reset.cursor)
            }
            _ => {}
        }
    }
    // #endregion
    Ok(seen)
}

/// Carries on from a saved cursor. A cursor the stream cannot carry on from is answered with `stream.reset`.
pub async fn resume_workspace_events(
    client: &Client,
    saved_cursor: &str,
) -> Result<Option<WorkspaceEvent>, Error> {
    // #region stream-reset
    let mut events = client
        .events()
        .watch()
        .types(["conversation.created"])
        .after(saved_cursor)
        .await?;
    let first = events.next().await.transpose()?;
    if let Some(WorkspaceEvent::StreamReset(reset)) = &first {
        // The cursor is too old or unknown: events since then are not replayed. Refresh what you hold from
        // the API, then carry on from the new cursor.
        println!("reset; carry on from {}", reset.cursor);
    }
    // #endregion
    Ok(first)
}

/// An agent's draft, a conversation with it, and a message.
pub async fn draft_conversation(client: &Client, agent_id: &str) -> Result<Message, Error> {
    // #region get-agent-version
    let draft = client.agent(agent_id).draft().get().await?;
    // the ETag is a field: send it back as if_match to change it
    println!("{} {:?}", draft.name, draft.etag);
    // #endregion
    // #region create-conversation
    // A conversation is with one version: here the draft, to test it before publishing.
    let conversation = client
        .agent(agent_id)
        .draft()
        .conversations()
        .create()
        .await?;
    println!(
        "{} created at {}",
        conversation.id(),
        conversation.result().created_at
    );
    // #endregion
    // #region send-message
    let mut answer = conversation
        .send("How many days of annual leave do staff get?")
        .await?
        .text();
    while let Some(text) = answer.next().await {
        print!("{}", text?);
    }
    // the complete message, with its citations
    let message = answer.final_message().await?;
    // #endregion
    Ok(message)
}

/// Asks a question about documents the message carries: a file on disk and an upload already sent.
pub async fn send_attachments(
    client: &Client,
    conversation_id: &str,
    path: &str,
    upload_id: &str,
) -> Result<Message, Error> {
    // #region send-attachments
    // Each file is uploaded for this conversation first, then one message names them all, in order. If a file fails to
    // upload, no message is sent and the call returns that file's error. Sending the same files again uploads them again.
    let mut answer = client
        .conversation(conversation_id)
        .send("Does this leave form match our policy?")
        .attachments([Attachment::file(path), Attachment::upload_id(upload_id)])
        .await?
        .text();
    while let Some(text) = answer.next().await {
        print!("{}", text?);
    }
    // #endregion
    answer.final_message().await
}
