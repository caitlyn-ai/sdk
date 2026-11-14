---
pageType: concept
sinceVersion: 5000115000000
resources:
  - conversation
integrations: []
operations:
  - SendMessage
  - ResumeConversationStream
---

# Streaming

An agent's answer arrives as it is written, as a stream of typed events. [SendMessage](/reference/send-message/)
returns one; each SDK gives you something to iterate, and the finished message at the end.

> **Not available yet.** Caitlyn workspaces do not serve the conversation operations yet. This page describes how
> the SDKs handle them.

<!-- example: examples/typescript/concepts.ts#streaming -->
```ts tab="TypeScript"
const stream = caitlyn.conversations.send(conversationId, { message: 'How much annual leave do part-time staff get?' });
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
with caitlyn.conversations.send(conversation_id, message="How much annual leave do part-time staff get?") as stream:
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
stream, err := client.Conversations.Send(ctx, conversationID, &caitlyn.SendMessageInput{
	Message: "How much annual leave do part-time staff get?",
})
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
let input = SendMessageInput {
    message: "How much annual leave do part-time staff get?".into(),
    ..Default::default()
};
let mut stream = client.conversations().send(CONVERSATION_ID, input).await?;
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

Each event has a `type` (Go `EventType()`, Rust `event_type()`) and its own data. The answer starts with
`message.started`, its text comes as `text.delta` fragments, and citations, progress steps and tool calls arrive
as they happen. It ends with exactly one of:

- `message.completed`, carrying the whole message, which `finalMessage()` (Python and Rust `final_message()`, Go
  `FinalMessage()`) returns. Call it after the loop, or instead of one: it reads the rest of the stream itself.
- `message.failed`, a problem details object like any [error](/errors/), which the SDK raises as the typed error
  when the loop reaches it.

[ConversationEvent](/reference/types/conversation-event/) lists every event. A newer server may send events this
SDK does not know; they are skipped, so an older SDK keeps working.

## Dropped connections

A proxy or load balancer can cut a long-lived connection. When the connection fails, or ends before the final
event, the SDK re-attaches with [ResumeConversationStream](/reference/resume-conversation-stream/), sending the ID
of the last event it saw (`Last-Event-ID`). The server replays what came after, and the SDK drops any event it
has already seen, so no event is lost or repeated. After three reconnections that fail, the stream raises
`STREAM_LOST`.

You can re-attach yourself, from another process for example, by calling `conversations.resume` with the
conversation and the last event ID you have. If the answer has already finished, that stream ends at once with
no events.

## Stopping early

<!-- example: examples/typescript/concepts.ts#cancelling -->
```ts tab="TypeScript"
// Give up after 30 seconds: the connection closes and the loop throws the signal's reason
const stream = caitlyn.conversations.send(conversationId, { message: 'Summarise the leave policy.' }, { signal: AbortSignal.timeout(30_000) });
for await (const event of stream) if (event.type === 'text.delta') process.stdout.write(event.delta);
```
<!-- example: examples/go/concepts/concepts.go#cancelling -->
```go tab="Go"
// Give up after 30 seconds: the connection closes and the loop returns the context's error
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
stream, err := client.Conversations.Send(ctx, conversationID, &caitlyn.SendMessageInput{Message: "Summarise the leave policy."})
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
