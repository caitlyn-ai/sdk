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

In short: start a conversation with what is live, send a message and read the answer's text as it is written.

<!-- example: examples/typescript/jobs.ts#chat -->
```ts tab="TypeScript"
const conversation = await caitlyn.agents(agentId).live.conversations.create();
for await (const text of conversation.send('How much leave do part-time staff get?').text()) process.stdout.write(text);
```
<!-- example: examples/python/jobs.py#chat -->
```python tab="Python"
conversation = caitlyn.agents(agent_id).live.conversations.create()
for text in conversation.send("How much leave do part-time staff get?").text():
    print(text, end="")
```
<!-- example: examples/go/conversations/conversations.go#chat -->
```go tab="Go"
conversation, err := client.Agent(agentID).Live().Conversations.Create(ctx, nil)
if err != nil {
	return nil, err
}
// Send sends the message before it returns; reading the stream is up to you
stream, err := conversation.Send(ctx, "How much leave do part-time staff get?")
if err != nil {
	return nil, err
}
defer stream.Close()
for text, err := range caitlyn.Text(stream) {
	if err != nil {
		return nil, err
	}
	fmt.Print(text)
}
```
<!-- example: examples/rust/src/conversations.rs#chat -->
```rust tab="Rust"
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
```

The steps below take this apart: which version you talk to, the events the answer arrives as, and attaching
documents.

<!-- not-available -->

## Read the agent's draft

[GetAgentVersion](/reference/get-agent-version/) returns one version of an agent, `draft` or a published name
such as `v12`, with its whole configuration. Read it to check which version you are about to talk to.

<!-- example: examples/typescript/conversations.ts#get-agent-version -->
```ts tab="TypeScript"
const draft = await caitlyn.agents(agentId).draft.get();
console.log(draft.configuration?.guidance?.instructions, draft.etag);
```
<!-- example: examples/python/conversations.py#get-agent-version -->
```python tab="Python"
draft = caitlyn.agents(agent_id).draft.get()
print(draft.configuration.guidance.instructions if draft.configuration and draft.configuration.guidance else "")
```
<!-- example: examples/go/conversations/conversations.go#get-agent-version -->
```go tab="Go"
draft, err := client.Agent(agentID).Draft().Get(ctx)
if err != nil {
	return nil, err
}
fmt.Println(draft.Name, draft.ETag) // send the ETag back as WithIfMatch to change the draft
```
<!-- example: examples/rust/src/conversations.rs#get-agent-version -->
```rust tab="Rust"
let draft = client.agent(agent_id).draft().get().await?;
// the ETag is a field: send it back as if_match to change it
println!("{} {:?}", draft.name, draft.etag);
```

## Start a conversation

[CreateConversation](/reference/create-conversation/) starts a conversation with an agent at one version and
returns its ID. Every message in the conversation is answered by that version. The SDK sends an idempotency key,
so a retried request does not start a second conversation.

<!-- example: examples/typescript/conversations.ts#create-conversation -->
```ts tab="TypeScript"
// The version you start it from answers, for the whole conversation
const conversation = await caitlyn.agents(agentId).live.conversations.create({ title: 'Annual leave' });
console.log(conversation.id, conversation.createdAt);
```
<!-- example: examples/python/conversations.py#create-conversation -->
```python tab="Python"
# A conversation is with one version of an agent: start it from that version (here the draft, to test it).
conversation = caitlyn.agents(agent_id).draft.conversations.create(title="Leave questions")
print(conversation.id)
```
<!-- example: examples/go/conversations/conversations.go#create-conversation -->
```go tab="Go"
// From the version that answers: Draft(), Live(), or a published one, such as Version("v3")
conversation, err := client.Agent(agentID).Draft().Conversations.Create(ctx, &caitlyn.CreateConversationInput{
	Title: caitlyn.Ptr("Leave questions"),
})
if err != nil {
	return nil, err
}
fmt.Println(conversation.ID())
```
<!-- example: examples/rust/src/conversations.rs#create-conversation -->
```rust tab="Rust"
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
```

## Send a message and stream the answer

[SendMessage](/reference/send-message/) sends a message and returns the answer as a stream of events: text as it
is written, the tools the agent uses, its citations, then `message.completed` with the finished message.
[Streaming](/streaming/) has the events, and what the SDK does when a connection drops.

<!-- example: examples/typescript/conversations.ts#send-message -->
```ts tab="TypeScript"
const stream = caitlyn.conversations(conversationId).send('How many days of annual leave do staff get?');
for await (const event of stream) {
  if (event.type === 'text.delta') process.stdout.write(event.delta);
}
// The answer as a whole: its text, citations and the agent version that wrote it
const answer = await stream.finalMessage();
console.log(`\n${answer.citations?.length ?? 0} citations`);
```
<!-- example: examples/python/conversations.py#send-message -->
```python tab="Python"
# The message is sent when send() is called; the stream may be read or dropped.
with caitlyn.conversations(conversation_id).send("How many days of annual leave do staff get?") as stream:
    for event in stream:
        if isinstance(event, TextDeltaEvent):
            print(event.delta, end="", flush=True)  # the answer as it is written
    answer = stream.final_message()
print("\n", len(answer.citations or []), "citations")
```
<!-- example: examples/go/conversations/conversations.go#send-message -->
```go tab="Go"
stream, err := client.Conversation(conversationID).Send(ctx, "How much annual leave do part-time staff get?")
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
let mut answer = conversation
    .send("How many days of annual leave do staff get?")
    .await?
    .text();
while let Some(text) = answer.next().await {
    print!("{}", text?);
}
// the complete message, with its citations
let message = answer.final_message().await?;
```

## Attach documents to a message

A message can carry documents for the agent to read with it, up to the number the agent version allows. Give each
as a file, or as the ID of an upload you made already. The SDK uploads each file for this conversation, in the order
given, and then sends the message naming them; if a file fails to upload, no message is sent. Each upload is used
up by the message, so sending the same files again uploads them again.

<!-- example: examples/typescript/conversations.ts#send-attachments -->
```ts tab="TypeScript"
// A path, a File or Blob, or an UploadFile; { uploadId } for a file uploaded already. If one fails to upload, no
// message is sent. Each upload is used up by the message: sending again uploads the files again
const stream = caitlyn.conversations(conversationId).send('Does this leave form match our policy?', { attachments: ['./leave.pdf'] });
for await (const delta of stream.text()) text += delta;
```
<!-- example: examples/python/conversations.py#send-attachments -->
```python tab="Python"
# Documents the message carries: each file is uploaded first, for this conversation, then the message names them
# in your order. An upload already sent goes as UploadId("…"). If a file fails to upload, no message is sent.
with caitlyn.conversations(conversation_id).send("Does this leave form match our policy?", attachments=[form]) as stream:
    answer = "".join(stream.text())
```
<!-- example: examples/go/conversations/conversations.go#send-attachments -->
```go tab="Go"
// Each file is uploaded for this conversation first, then one message names them all, in order. If a file fails to
// upload, no message is sent and Send returns that file's error. Sending the same files again uploads them again.
stream, err := client.Conversation(conversationID).Send(ctx, "Does this leave form match our policy?",
	caitlyn.WithAttachments(caitlyn.Path(path), caitlyn.UploadID(uploadID)))
if err != nil {
	return nil, err
}
defer stream.Close()
for text, err := range caitlyn.Text(stream) {
	if err != nil {
		return nil, err
	}
	fmt.Print(text)
}
```
<!-- example: examples/rust/src/conversations.rs#send-attachments -->
```rust tab="Rust"
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
```
