---
pageType: guide
sinceVersion: 5000115000000
resources:
  - agent
  - version
  - conversation
integrations: []
operations:
  - GetAgentVersion
  - CreateConversation
  - SendMessage
---

# Ask an agent

Read the agent you are about to use, start a conversation with one of its versions, then send messages and
stream each answer as it is written, with its citations.

> **Not available yet.** The SDKs have the conversation operations, but Caitlyn workspaces do not serve them yet.
> This page describes how the SDKs call them.

## Read the agent's draft

[GetAgentVersion](/reference/get-agent-version/) returns one version of an agent, `draft` or a published name
such as `v12`, with its whole configuration. Read it to check which version you are about to talk to.

<!-- example: examples/typescript/conversations.ts#get-agent-version -->
```ts tab="TypeScript"
const draft = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
console.log(draft.configuration.instructions, draft.etag);
```
<!-- example: examples/python/conversations.py#get-agent-version -->
```python tab="Python"
draft = caitlyn.agents.versions.get(agent_id=agent_id, version="draft")
print(draft.configuration.instructions)
```
<!-- example: examples/go/conversations/conversations.go#get-agent-version -->
```go tab="Go"
draft, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
if err != nil {
	return nil, err
}
fmt.Println(draft.Name, draft.ETag) // send the ETag back as WithIfMatch to change the draft
```
<!-- example: examples/rust/src/conversations.rs#get-agent-version -->
```rust tab="Rust"
let input = GetAgentVersionInput {
    agent_id: agent_id.into(),
    version: "draft".into(),
};
let draft = client.agents().versions().get(input).await?;
println!("{}: {}", draft.name, draft.configuration.instructions);
println!("ETag {:?}", draft.response_metadata.etag); // send it back as if_match to change the draft
```

## Start a conversation

[CreateConversation](/reference/create-conversation/) starts a conversation with an agent at one version and
returns its ID. Every message in the conversation is answered by that version. The SDK sends an idempotency key,
so a retried request does not start a second conversation.

<!-- example: examples/typescript/conversations.ts#create-conversation -->
```ts tab="TypeScript"
// Only the draft can answer for now; production and named versions arrive with agent versions
const conversation = await caitlyn.conversations.create({ agentId, version: 'draft', title: 'Annual leave' });
console.log(conversation.id, conversation.createdAt);
```
<!-- example: examples/python/conversations.py#create-conversation -->
```python tab="Python"
conversation = caitlyn.conversations.create(agent_id=agent_id, version="draft", title="Leave questions")
print(conversation.id)
```
<!-- example: examples/go/conversations/conversations.go#create-conversation -->
```go tab="Go"
conversation, err := client.Conversations.Create(ctx, &caitlyn.CreateConversationInput{
	AgentID: agentID,
	Version: "draft", // or a published version, such as "v3"
	Title:   caitlyn.Ptr("Leave questions"),
})
if err != nil {
	return nil, err
}
fmt.Println(conversation.ID)
```
<!-- example: examples/rust/src/conversations.rs#create-conversation -->
```rust tab="Rust"
let input = CreateConversationInput {
    agent_id: agent_id.into(),
    version: "draft".into(),
    title: None,
};
let conversation = client.conversations().create(input).await?;
println!("{} created at {}", conversation.id, conversation.created_at);
```

## Send a message and stream the answer

[SendMessage](/reference/send-message/) sends a message and returns the answer as a stream of events: text as it
is written, the tools the agent uses, its citations, then `message.completed` with the finished message.
[Streaming](/streaming/) has the events, and what the SDK does when a connection drops.

<!-- example: examples/typescript/conversations.ts#send-message -->
```ts tab="TypeScript"
const stream = caitlyn.conversations.send(conversationId, { message: 'How many days of annual leave do staff get?' });
for await (const event of stream) {
  if (event.type === 'text.delta') process.stdout.write(event.delta);
}
// The answer as a whole: its text, citations and the agent version that wrote it
const answer = await stream.finalMessage();
console.log(`\n${answer.citations?.length ?? 0} citations`);
```
<!-- example: examples/python/conversations.py#send-message -->
```python tab="Python"
with caitlyn.conversations.send(conversation_id, message="How many days of annual leave do staff get?") as stream:
    for event in stream:
        if isinstance(event, TextDeltaEvent):
            print(event.delta, end="", flush=True)  # the answer as it is written
    answer = stream.final_message()
print("\n", len(answer.citations or []), "citations")
```
<!-- example: examples/go/conversations/conversations.go#send-message -->
```go tab="Go"
stream, err := client.Conversations.Send(ctx, conversationID, &caitlyn.SendMessageInput{
	Message: "How much annual leave do part-time staff get?",
})
if err != nil {
	return nil, err
}
defer stream.Close()
for event, err := range stream.Events() {
	if err != nil {
		return nil, err
	}
	if delta, ok := event.(*caitlyn.TextDelta); ok {
		fmt.Print(delta.Delta)
	}
}
answer, err := stream.FinalMessage() // the complete message, with its citations
if err != nil {
	return nil, err
}
fmt.Println()
```
<!-- example: examples/rust/src/conversations.rs#send-message -->
```rust tab="Rust"
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
```
