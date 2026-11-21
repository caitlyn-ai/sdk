---
pageType: concept
sinceVersion: 5000115000000
resources:
  - conversation
  - workspace
integrations: []
operations:
  - SendMessage
  - WatchConversation
  - WatchWorkspaceEvents
---

# Streaming

An agent's answer arrives as it is written, as a stream of typed events. [SendMessage](/reference/send-message/)
returns one; each SDK gives you something to iterate, and the finished message at the end.

<!-- not-available -->

<!-- example: examples/typescript/concepts.ts#streaming -->
```ts tab="TypeScript"
const stream = caitlyn.conversations(conversationId).send('How much annual leave do part-time staff get?');
for await (const event of stream) {
  switch (event.type) {
    case 'text.delta':
      process.stdout.write(event.delta);
      break;
    case 'citation.added':
      console.log(`\n[${event.citation.number}] ${event.citation.documentName}`);
      break;
  }
}
const answer = await stream.finalMessage(); // the complete message, with its citations
console.log(answer.id, stream.requestId);
```
<!-- example: examples/python/concepts.py#streaming -->
```python tab="Python"
with caitlyn.conversations(conversation_id).send("How much annual leave do part-time staff get?") as stream:
    for event in stream:
        if isinstance(event, TextDeltaEvent):
            print(event.delta, end="", flush=True)
        elif isinstance(event, CitationAddedEvent):
            print(f"\n[{event.citation.number}] {event.citation.document_name}")
    answer = stream.final_message()  # the complete message, with its citations
    print(answer.id, stream.request_id)
```
<!-- example: examples/go/concepts/concepts.go#streaming -->
```go tab="Go"
stream, err := client.Conversation(conversationID).Send(ctx, "How much annual leave do part-time staff get?")
if err != nil {
	return err
}
defer stream.Close()
for event, err := range stream.Events() {
	if err != nil {
		return err
	}
	switch e := event.(type) {
	case *caitlyn.TextDelta:
		fmt.Print(e.Delta)
	case *caitlyn.CitationAdded:
		fmt.Printf("\n[%d] %s\n", e.Citation.Number, *e.Citation.DocumentName)
	}
}
answer, err := stream.FinalMessage() // the complete message, with its citations
if err != nil {
	return err
}
fmt.Println(answer.ID, stream.RequestID())
```
<!-- example: examples/rust/src/concepts.rs#streaming -->
```rust tab="Rust"
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
```

## The events

Each event has a `type` and its own data (the example above reads both). The answer starts with
`message.started`, its text comes as `text.delta` fragments, and citations, progress steps and tool calls arrive
as they happen. It ends with exactly one of:

- `message.completed`, carrying the whole message, which the stream's final-message call returns (the example
  above ends with it). Call it after the loop, or instead of one: it reads the rest of the stream itself.
- `message.failed`, a problem details object like any [error](/errors/), which the SDK raises as the typed error
  when the loop reaches it.

[ConversationEvent](/reference/types/conversation-event/) lists every event. A newer server may send events this
SDK does not know; they are skipped, so an older SDK keeps working.

## Dropped connections

A proxy or load balancer can cut a long-lived connection. When the connection fails, or ends before the final
event, the SDK re-attaches with [WatchConversation](/reference/watch-conversation/), sending the ID
of the last event it saw (`Last-Event-ID`). The server replays what came after, and the SDK drops any event it
has already seen, so no event is lost or repeated. Before each reconnection it waits a little longer than the
last time (a quarter to half a second, then up to one second, then up to two), and after three in a row that bring
no new event, the stream raises `STREAM_LOST`. A connection that stayed open for a minute or more starts that count
again. Caitlyn ends every stream after at most an hour, and the SDK reconnects as it does after any clean end, so a
watch that stays quiet for hours keeps going.

The answer's stream still ends at `message.completed` or `message.failed`, although the watch it re-attached
with would carry on. If the answer finished while the connection was down, the watch sends `stream.reset`
instead: the stream gives you that event and ends there, with no error, and `finalMessage()` fails with
`NO_FINAL_EVENT`, because the final event went to the connection that dropped. Read the answer from the
conversation's messages.

## Watch a conversation

[WatchConversation](/reference/watch-conversation/) streams a conversation's answers, from another process for
example: the answer being written, if there is one, then every answer after it. Each answer ends with
`message.completed` or `message.failed`, and the stream carries on until you close it, so close it once you
have the event you were waiting for. On a watch, `message.failed` is an event like any other, not an error: it
ends that answer, and the watch carries on to the next. When its connection drops, or the server restarts, the watch reconnects by
itself and carries on from the last event it saw.

<!-- example: examples/typescript/conversations.ts#watch-conversation -->
```ts tab="TypeScript"
// Open the watch first; the answer could come from anywhere (another tab, another service): here it is sent below
const conversation = caitlyn.conversations(conversationId);
const watch = conversation.watch();
await watch.opened();
const answer = conversation.send('Does that include public holidays?').finalMessage();
let watched;
for await (const event of watch) {
  // A watch can begin with an answer already in the conversation: wait for the one you are interested in
  if (event.type === 'message.completed' && event.message.id === (await answer).id) {
    watched = event.message;
    break; // a watch stays open across answers, and reconnects by itself: stop at the event you wait for
  }
}
```
<!-- example: examples/python/conversations.py#watch-conversation -->
```python tab="Python"
# The answer being written now, from its start, then every answer after it, until you close the stream.
text = ""
with caitlyn.conversations(conversation_id).watch() as stream:
    for event in stream:
        if isinstance(event, TextDeltaEvent):
            text += event.delta
        elif isinstance(event, (MessageCompletedEvent, MessageFailedEvent)):
            break  # this answer is over; leaving the `with` closes the stream
```
<!-- example: examples/go/conversations/conversations.go#watch-conversation -->
```go tab="Go"
// The answer being written, if any, from its start, then every answer after it, until you close the stream. Each
// answer ends with message.completed or message.failed; the stream carries on after either.
stream, err := client.Conversation(conversationID).Watch(ctx, nil)
if err != nil {
	return nil, err
}
defer stream.Close()
for event, err := range stream.Events() {
	if err != nil {
		return nil, err
	}
	switch e := event.(type) {
	case *caitlyn.TextDelta:
		fmt.Print(e.Delta)
	case *caitlyn.MessageCompleted:
		fmt.Println()
		return &e.Message, nil // the answer is complete: stop watching
	case *caitlyn.MessageFailed:
		return nil, fmt.Errorf("the answer failed: %s, %s [%s]", e.Code, e.Title, e.RequestID) // stop watching
	}
}
```
<!-- example: examples/rust/src/conversations.rs#watch-conversation -->
```rust tab="Rust"
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
```

## Workspace events

[WatchWorkspaceEvents](/reference/watch-workspace-events/) streams what happens in the workspace: a conversation
created, an answer completed or failed, a tool finished, input requested. Name what to listen to, by event type,
by conversation or both; you receive an event only when you may read the conversation it is about.

Each event's ID is a cursor. To carry on from an event after a disconnection, send its ID as `after`; without
one, the stream starts now. To wait for something your own call will cause, open the stream first, then make the
call. Like a conversation watch, the stream reconnects by itself with the same request, from the last
event it saw.

<!-- example: examples/typescript/conversations.ts#watch-workspace-events -->
```ts tab="TypeScript"
// Open the stream first, then make the call, so the event cannot arrive before you listen
const listening = new AbortController();
const events = caitlyn.events.watch({ types: ['conversation.created'] }, { signal: listening.signal });
try {
  await events.opened(); // the response headers have arrived: the stream is listening
  const conversation = await caitlyn.agents(agentId).draft.conversations.create();
  for await (const event of events) {
    if (event.type === 'conversation.created' && event.data.id === conversation.id) {
      console.log(`created ${event.data.id} at ${event.occurredAt}; carry on from ${event.eventId}`);
      return { conversation, created: event };
    }
  }
  return { conversation, created: undefined }; // the stream ended first
} finally {
  listening.abort(); // closes the stream
}
```
<!-- example: examples/python/conversations.py#watch-workspace-events -->
```python tab="Python"
# Open the stream first, then make the call whose events you want: the stream starts from now.
with caitlyn.events.watch(types=["conversation.created"]) as stream:
    conversation_id = caitlyn.agents(agent_id).draft.conversations.create().id
    for event in stream:
        if isinstance(event, WorkspaceConversationCreatedEvent) and event.subject.id == conversation_id:
            print("created", event.subject.id, "by", event.actor.type)
            break
```
<!-- example: examples/go/conversations/conversations.go#watch-workspace-events -->
```go tab="Go"
// Open the stream first, then make the call whose event you are waiting for
events, err := client.Events.Watch(ctx, &caitlyn.WatchWorkspaceEventsInput{
	Types: []string{"conversation.created"},
})
if err != nil {
	return nil, err
}
defer events.Close()

conversation, err := client.Agent(agentID).Draft().Conversations.Create(ctx, nil)
if err != nil {
	return nil, err
}
for event, err := range events.Events() {
	if err != nil {
		return nil, err
	}
	if created, ok := event.(*caitlyn.ConversationCreatedEvent); ok && created.Data.ID == conversation.ID() {
		fmt.Println(created.Data.ID, created.OccurredAt, created.EventID()) // the event ID is a cursor
		return created, nil
	}
}
```
<!-- example: examples/rust/src/conversations.rs#watch-workspace-events -->
```rust tab="Rust"
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
```

## When the stream resets

A cursor the server can no longer carry on from, because it is more than a day old or catching up from it would
take too long, is answered with a `stream.reset` event rather than an error. Its `cursor` is where the stream
now carries on from, and it is also the event's ID. The events in between are never sent: read what you need
again with the List and Get operations, then carry on. The SDK delivers `stream.reset` to you like any other
event; it never raises it or retries.

<!-- example: examples/typescript/conversations.ts#stream-reset -->
```ts tab="TypeScript"
let cursor = savedCursor; // the last event's eventId, saved between runs
for await (const event of caitlyn.events.watch({ types: ['conversation.created'], after: cursor })) {
  if (event.type === 'stream.reset') {
    // Events since the saved cursor are not replayed: re-read what you depend on, then carry on
    await resync();
  }
  cursor = event.eventId ?? cursor; // a stream.reset's eventId is its new cursor
  await handle(event);
}
```
<!-- example: examples/python/conversations.py#stream-reset -->
```python tab="Python"
# A cursor more than a day old (or too far behind) is answered with stream.reset, not an error, and the
# stream carries on from there. The events in between are never sent.
with caitlyn.events.watch(types=["conversation.created"], after=cursor) as stream:
    for event in stream:
        if isinstance(event, StreamResetEvent):
            refresh()  # read again, with the List and Get operations, what you depend on
        else:
            handle(event)
        if event.event_id:
            save_cursor(event.event_id)  # a stream.reset's ID is its new cursor; send it back as `after`
```
<!-- example: examples/go/conversations/conversations.go#stream-reset -->
```go tab="Go"
// Carry on after the last event you handled. A cursor the stream cannot carry on from (too old, say) is
// answered with a StreamReset event and a new cursor, not an error.
events, err := client.Events.Watch(ctx, &caitlyn.WatchWorkspaceEventsInput{
	Types: []string{"conversation.created"},
	After: caitlyn.Ptr(savedCursor),
})
if err != nil {
	return savedCursor, err
}
defer events.Close()
for event, err := range events.Events() {
	if err != nil {
		return savedCursor, err
	}
	if reset, ok := event.(*caitlyn.StreamReset); ok {
		// Events since the old cursor may be missing: read the current state again, then carry on
		fmt.Println("Carrying on from", reset.Cursor)
	}
	if err := handle(event); err != nil {
		return savedCursor, err
	}
	savedCursor = event.EventID() // save it once the event is handled
}
```
<!-- example: examples/rust/src/conversations.rs#stream-reset -->
```rust tab="Rust"
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
```

## Stopping early

<!-- example: examples/typescript/concepts.ts#cancelling -->
```ts tab="TypeScript"
// Give up after 30 seconds: the connection closes and the loop throws the signal's reason
const stream = caitlyn.conversations(conversationId).send('Summarise the leave policy.', {}, { signal: AbortSignal.timeout(30_000) });
for await (const event of stream) if (event.type === 'text.delta') process.stdout.write(event.delta);
```
<!-- example: examples/go/concepts/concepts.go#cancelling -->
```go tab="Go"
// Give up after 30 seconds: the connection closes and the loop returns the context's error
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
stream, err := client.Conversation(conversationID).Send(ctx, "Summarise the leave policy.")
if err != nil {
	return err
}
defer stream.Close()
for event, err := range stream.Events() {
	if err != nil {
		return err
	}
	if delta, ok := event.(*caitlyn.TextDelta); ok {
		fmt.Print(delta.Delta)
	}
}
```

In Python, leave the `with` block (or call `close()`); in Rust, drop the stream. Cancelling is never reported as
a connection error or `STREAM_LOST`: you get your language's own cancellation error.

Sending a message is never retried by the SDK, because sending it twice would ask the question twice. If the
send fails before the stream starts, the error is yours to handle.
