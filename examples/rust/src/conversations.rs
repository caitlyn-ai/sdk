//! The code the developer docs show for each operation, one region each. src/bin/examples_live.rs runs every
//! one of them against a real Caitlyn server (scripts/examples-live/rust.sh), and scripts/test-rust.sh runs
//! clippy over them.
use caitlyn_sdk::{AgentVersion, Client, Conversation, ConversationCreatedEvent, Message};
use caitlyn_sdk::{
    Caller, ConversationEvent, CreateConversationInput, Error, GetAgentVersionInput, GetCallerInput, SendMessageInput,
    WatchConversationInput, WatchWorkspaceEventsInput, WorkspaceEvent,
};

/// Who the credential belongs to.
pub async fn get_caller(client: &Client) -> Result<Caller, Error> {
    // #region get-caller
    let caller = client.callers().get(GetCallerInput {}).await?;
    println!("{} ({:?}) in {}", caller.display_name, caller.credential, caller.organisation.name);
    println!("scopes: {}", caller.scopes.join(" "));
    // #endregion
    Ok(caller)
}

/// An agent's draft.
pub async fn get_agent_version(client: &Client, agent_id: &str) -> Result<AgentVersion, Error> {
    // #region get-agent-version
    let input = GetAgentVersionInput {
        agent_id: agent_id.into(),
        version: "draft".into(),
    };
    let draft = client.agents().versions().get(input).await?;
    println!("{}: {}", draft.name, draft.configuration.instructions);
    println!("ETag {:?}", draft.response_metadata.etag); // send it back as if_match to change the draft
                                                         // #endregion
    Ok(draft)
}

/// A new conversation with an agent's draft.
pub async fn create_conversation(client: &Client, agent_id: &str) -> Result<Conversation, Error> {
    // #region create-conversation
    let input = CreateConversationInput {
        agent_id: agent_id.into(),
        version: "draft".into(),
        title: None,
    };
    let conversation = client.conversations().create(input).await?;
    println!("{} created at {}", conversation.id, conversation.created_at);
    // #endregion
    Ok(conversation)
}

/// Sends a message and reads the answer as it is written.
pub async fn send_message(client: &Client, conversation_id: &str) -> Result<Message, Error> {
    // #region send-message
    let input = SendMessageInput {
        message: "In one sentence, what can you help me with?".into(),
        ..Default::default()
    };
    let mut stream = client.conversations().send(conversation_id, input).await?;
    while let Some(event) = stream.next().await {
        if let ConversationEvent::TextDelta(delta) = event? {
            print!("{}", delta.delta);
        }
    }
    let answer = stream.final_message().await?; // the complete message, with its citations
    println!();
    // #endregion
    Ok(answer)
}

/// Follows an answer being written, from another process or after a dropped connection.
pub async fn watch_conversation(client: &Client, conversation_id: &str) -> Result<Option<ConversationEvent>, Error> {
    // #region watch-conversation
    // The answer being written, if there is one, then every answer after it, until you close the stream. The SDK
    // reconnects by itself; set last_event_id to carry on after an event you already have.
    let mut stream = client
        .conversations()
        .watch(conversation_id, WatchConversationInput::default())
        .await?;
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
pub async fn watch_workspace_events(client: &Client, agent_id: &str) -> Result<Option<ConversationCreatedEvent>, Error> {
    // #region watch-workspace-events
    // Open the stream first, so it sees what the next call causes; without `after` it starts now.
    let input = WatchWorkspaceEventsInput {
        types: Some(vec!["conversation.created".into()]),
        ..Default::default()
    };
    let mut events = client.events().subscribe(input).await?;

    let input = CreateConversationInput {
        agent_id: agent_id.into(),
        version: "draft".into(),
        title: None,
    };
    let conversation = client.conversations().create(input).await?;

    let mut seen = None;
    while let Some(event) = events.next().await {
        match event? {
            WorkspaceEvent::ConversationCreatedEvent(created) if created.data.id == conversation.id => {
                // Its event_id is a cursor: send it back as `after` to carry on from here.
                println!("{} created by a {:?} caller", created.data.id, created.actor.r#type);
                seen = Some(created);
                break; // dropping the stream closes it
            }
            WorkspaceEvent::StreamReset(reset) => println!("events were missed; carry on from {}", reset.cursor),
            _ => {}
        }
    }
    // #endregion
    Ok(seen)
}

/// Carries on from a saved cursor. A cursor the stream cannot carry on from is answered with `stream.reset`.
pub async fn resume_workspace_events(client: &Client, saved_cursor: &str) -> Result<Option<WorkspaceEvent>, Error> {
    // #region stream-reset
    let input = WatchWorkspaceEventsInput {
        types: Some(vec!["conversation.created".into()]),
        after: Some(saved_cursor.into()),
        ..Default::default()
    };
    let mut events = client.events().subscribe(input).await?;
    let first = events.next().await.transpose()?;
    if let Some(WorkspaceEvent::StreamReset(reset)) = &first {
        // The cursor is too old or unknown: events since then are not replayed. Refresh what you hold from
        // the API, then carry on from the new cursor.
        println!("reset; carry on from {}", reset.cursor);
    }
    // #endregion
    Ok(first)
}
