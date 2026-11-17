---
pageType: guide
sinceVersion: 5000115000000
resources:
  - agent
  - version
integrations: []
operations:
  - GetAgentVersion
  - UpdateDraftVersion
  - SaveDraftVersion
  - ListAgentVersions
  - PublishAgentVersion
  - ListHistoryEntries
  - GetHistoryEntry
  - ResetDraftVersion
  - DeleteAgentVersion
---

# Change an agent safely

Change an agent's draft, keep the draft you tested as a named version, publish it so it goes live, and roll back
if you need to. What is live only changes when you publish, and any change to the draft or to live can be checked
against the version you last read, so two people cannot overwrite each other's work.

In short: create an agent and publish its first version, and later point live at an earlier version again.

<!-- example: examples/typescript/jobs.ts#publish-agent+roll-back "Later: put live back on an earlier version" -->
```ts tab="TypeScript"
const agent = await caitlyn.agents.create({ name: 'HR assistant', configuration: { guidance: { instructions } } });
await agent.draft.publish({ name: 'v1' });

// Later: put live back on an earlier version
await caitlyn.agents(agentId).versions('v13').publish();
```
<!-- example: examples/python/jobs.py#publish-agent+roll-back "Later: put live back on an earlier version" -->
```python tab="Python"
agent = caitlyn.agents.create(name="HR assistant", configuration={"guidance": {"instructions": instructions}})
agent.draft.publish(name="v1")

# Later: put live back on an earlier version
# Live points at v13 again. v13 itself is unchanged, and the agent's history records the move as a rollback.
caitlyn.agents(agent_id).versions("v13").publish()
```
<!-- example: examples/go/agents/agents.go#publish-agent+roll-back "Later: put live back on an earlier version" -->
```go tab="Go"
agent, err := client.Agents.Create(ctx, &caitlyn.CreateAgentInput{
	Name:          "HR assistant",
	Configuration: &caitlyn.AgentConfiguration{Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr(instructions)}},
})
if err != nil {
	return nil, err
}
// agent is the new agent's scope, carrying the response: agent.Draft() is at hand, with no second lookup
published, err := agent.Draft().Publish(ctx, &caitlyn.PublishAgentVersionInput{Name: caitlyn.Ptr("v1")})
if err != nil {
	return nil, err
}
fmt.Println(agent.ID(), published.Live.Version) // live now points at v1

// Later: put live back on an earlier version
// v13 itself is unchanged; the agent's history records the move as a rollback
rolledBack, err := client.Agent(agentID).Version("v13").Publish(ctx, nil)
if err != nil {
	return nil, err
}
fmt.Println(rolledBack.Live.Version, rolledBack.HistoryEntry.Kind)
```
<!-- example: examples/rust/src/agents.rs#publish-agent+roll-back "Later: put live back on an earlier version" -->
```rust tab="Rust"
let agent = client
    .agents()
    .create("HR assistant")
    .configuration(AgentConfiguration {
        guidance: Some(AgentGuidance {
            instructions: Some(instructions.into()),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;
// create returns the agent's scope: its draft is there at once.
let published = agent.draft().publish().name("v1").await?;
println!("{} live: {}", agent.id(), published.live.version);

// Later: put live back on an earlier version
let published = client.agent(agent_id).version("v13").publish().await?;
// Live points at v13 again; v13 itself is unchanged, and the history records the move as a rollback.
println!(
    "live is {} ({})",
    published.live.version, published.history_entry.id
);
```


The steps below go through the draft, the versions you keep, publishing and the live history.

<!-- not-available -->

## Change the draft

Every agent has a draft, which you change, and a live version, which your users talk to.
[UpdateDraftVersion](/reference/update-draft-version/) changes the draft. The draft's ETag is optional
([conditional writes](/errors/#conditional-writes-etags-and-if-match)): with it, a draft someone else changed since you read it is refused with 412, and you read it again
and reapply your change; without it, the change applies to the draft as it is. To replace the whole configuration at once,
use the draft's `replace` ([ReplaceDraftVersion](/reference/replace-draft-version/)); its ETag is optional in the
same way.

<!-- example: examples/typescript/agents.ts#update-draft -->
```ts tab="TypeScript"
const draft = caitlyn.agents(agentId).draft;
const current = await draft.get();
// If-Match is optional here; with it, a draft someone changed since is refused with 412: read it again and reapply
const updated = await draft.update({ guidance: { instructions } }, { ifMatch: current.etag });
console.log(updated.configuration?.guidance?.instructions, updated.etag);
```
<!-- example: examples/python/agents.py#update-draft -->
```python tab="Python"
# Change only the members you send. With the draft's ETag (if_match=), a draft someone else changed since you
# read it is refused with 412; without it, the change applies to the draft as it is.
draft = agent.draft.update(guidance=AgentGuidance(instructions=instructions))
if draft.configuration and draft.configuration.guidance:
    print(draft.configuration.guidance.instructions)
```
<!-- example: examples/go/agents/agents.go#update-draft -->
```go tab="Go"
// Changes only the fields you set. If-Match is optional here: with it, a draft someone else changed since you read
// it is refused with a *caitlyn.PreconditionFailedError.
updated, err := client.Agent(agentID).Draft().Update(ctx, &caitlyn.UpdateDraftVersionInput{
	Guidance: &caitlyn.AgentGuidance{Instructions: caitlyn.Ptr(instructions)},
})
if err != nil {
	return nil, err
}
fmt.Println(updated.ETag) // the new ETag, for a change that must not overwrite another
```
<!-- example: examples/rust/src/agents.rs#update-draft -->
```rust tab="Rust"
let agent = client.agent(agent_id);
// If-Match is optional on the draft: set it to refuse the change if someone else changed the draft first.
let draft = agent.draft().get().await?;
agent
    .draft()
    .update()
    .guidance(AgentGuidance {
        instructions: Some(
            "Answer leave and pay questions. Quote the clause you relied on.".into(),
        ),
        ..Default::default()
    })
    .if_match(&draft.etag)
    .await?;
```

## Keep the draft you tested

Once the draft behaves as you want, keep it. [SaveDraftVersion](/reference/save-draft-version/) saves
the draft as a new named version, with a note saying why. With the draft's ETag, only the draft you tested is saved.
Saving does not change what is live, and the draft carries on as before.

<!-- example: examples/typescript/agents.ts#save-draft-version -->
```ts tab="TypeScript"
const draft = caitlyn.agents(agentId).draft;
// With the draft's ETag, only the draft you read is saved
const saved = await draft.save(name, { note: 'Before the leave policy change' }, { ifMatch: (await draft.get()).etag });
console.log(`${saved.name} saved at ${saved.createdAt.toISOString()}`);
```
<!-- example: examples/python/agents.py#save-draft-version -->
```python tab="Python"
# Keep the draft you tested as a named version; live does not change.
saved = agent.draft.save(name, note="Tested with the leave questions")
print(saved.name, saved.created_at)
```
<!-- example: examples/go/agents/agents.go#save-draft-version -->
```go tab="Go"
saved, err := client.Agent(agentID).Draft().Save(ctx, &caitlyn.SaveDraftVersionInput{
	Name: name, // for example "november-release"
	Note: caitlyn.Ptr("Quotes the policy clause it relied on."),
})
if err != nil {
	return nil, err
}
fmt.Println(saved.Name, saved.CreatedAt)
```
<!-- example: examples/rust/src/agents.rs#save-draft-version -->
```rust tab="Rust"
// Keeps the draft as a version; live is unchanged.
let saved = agent
    .draft()
    .save("checked-2026-11")
    .note("Checked by HR")
    .await?;
println!("{}", saved.name);
```

[ListAgentVersions](/reference/list-agent-versions/) lists the agent's named versions, oldest first, and says
which one is live. The draft and live are not in the list; read them by name with
[GetAgentVersion](/reference/get-agent-version/).

<!-- example: examples/typescript/agents.ts#list-versions -->
```ts tab="TypeScript"
for await (const version of caitlyn.agents(agentId).versions.list()) {
  console.log(version.name, version.matchesLive ? '(live)' : '', version.note ?? '');
  names.push(version.name);
}
```
<!-- example: examples/python/agents.py#list-versions -->
```python tab="Python"
# The agent's named versions (the draft and live are not entries). Pages are fetched as needed.
for version in agent.versions.list():
    names.append(version.name)
    print(version.name, version.matches_live)
```
<!-- example: examples/go/agents/agents.go#list-versions -->
```go tab="Go"
var versions []caitlyn.AgentVersion
for version, err := range client.Agent(agentID).Versions.List(ctx, nil) {
	if err != nil {
		return nil, err
	}
	matches := version.MatchesLive != nil && *version.MatchesLive // the version agents run now
	fmt.Println(version.Name, version.CreatedAt, matches)
	versions = append(versions, version)
}
```
<!-- example: examples/rust/src/agents.rs#list-versions -->
```rust tab="Rust"
let mut versions = agent.versions().list().items();
while let Some(version) = versions.next().await {
    let version = version?;
    println!("{} {:?}", version.name, version.created_at);
}
```

## Publish

[PublishAgentVersion](/reference/publish-agent-version/) points live at a version: from then on, your users talk to
it. Versions never change once made, so live answers exactly as the version it names. Give the version live points
at now (`expectedLive`, or live's ETag as `ifMatch`) and a publish is refused with 412 if live moved since you looked,
so two publishes cannot overwrite each other; for an agent's first publish, when it has no live version yet, that
check is `*`.

<!-- example: examples/typescript/agents.ts#publish-version -->
```ts tab="TypeScript"
// expectedLive (or If-Match with live's ETag) is an optional check that live has not moved since you looked
const agent = caitlyn.agents(agentId);
const live = await agent.live.get();
const published = await agent.versions(version).publish({ note: 'Leave policy update', expectedLive: live.liveVersion });
console.log(`live is now ${published.live.version}, ${published.historyEntry.kind} by ${published.live.publishedBy.displayName}`);
```
<!-- example: examples/python/agents.py#publish-version -->
```python tab="Python"
# Live runs the named version from now on, and the move is kept in the live history. A version that was live
# before is a rollback. expected_live= (or if_match= with live's ETag) refuses it if live moved meanwhile.
published = agent.versions(name).publish()
print("live is now", published.live.version, published.history_entry.kind)
```
<!-- example: examples/go/agents/agents.go#publish-version -->
```go tab="Go"
published, err := client.Agent(agentID).Version(version).Publish(ctx, &caitlyn.PublishAgentVersionInput{
	ExpectedLive: caitlyn.Ptr(expectedLive), // refused if live is no longer this version
	Note:         caitlyn.Ptr("Answers leave questions with the clause it relied on."),
})
var changed *caitlyn.PreconditionFailedError
if errors.As(err, &changed) {
	return nil, fmt.Errorf("the live version changed since you looked: check what is live, then publish again: %w", err)
}
if err != nil {
	return nil, err
}
fmt.Println(published.Live.Version, published.Live.PublishedAt)
```
<!-- example: examples/rust/src/agents.rs#publish-version -->
```rust tab="Rust"
// Points live at a version: a rollback when it was live before. If-Match on live is optional.
let published = agent
    .version("checked-2026-11")
    .publish()
    .note("Back to the checked version")
    .await?;
println!(
    "live is {} since {}",
    published.live.version, published.live.published_at
);
```

## See what was live

Every time live moves to another version, the agent's live history gains an entry: the version live pointed at
before and after, what kind of change it was, who made it and when. Entries are never edited or deleted.
[ListHistoryEntries](/reference/list-history-entries/) lists them, newest first, and
[GetHistoryEntry](/reference/get-history-entry/) reads one with the configuration live had.

<!-- example: examples/typescript/agents.ts#list-history -->
```ts tab="TypeScript"
for await (const entry of caitlyn.agents(agentId).history.list()) {
  console.log(`${entry.changedAt.toISOString()}: live moved from ${entry.previousVersion ?? '(nothing)'} to ${entry.version} (${entry.kind})`);
  ids.push(entry.id);
}
```
<!-- example: examples/python/agents.py#list-history -->
```python tab="Python"
# Each time live moved to another version, newest first: by a publish or a rollback, who did it and when.
for entry in agent.history.list():
    ids.append(entry.id)
    print(entry.kind, entry.previous_version, "->", entry.version, entry.changed_at)
```
<!-- example: examples/go/agents/agents.go#list-history -->
```go tab="Go"
// Newest first: each entry is a version that went live, the one it replaced, and who changed it when
var entries []caitlyn.HistoryEntry
for entry, err := range client.Agent(agentID).History.List(ctx, nil) {
	if err != nil {
		return nil, err
	}
	fmt.Println(entry.ChangedAt, entry.Kind, entry.Version, entry.ChangedBy.DisplayName)
	entries = append(entries, entry)
}
```
<!-- example: examples/rust/src/agents.rs#list-history -->
```rust tab="Rust"
let history = agent.history().list().collect().await?;
for entry in &history {
    println!("{} {} {:?}", entry.id, entry.version, entry.kind);
}
```
<!-- example: examples/typescript/agents.ts#get-history -->
```ts tab="TypeScript"
const entry = await caitlyn.agents(agentId).history(historyEntryId).get();
console.log(entry.version, entry.changedBy.displayName, entry.configuration?.guidance?.instructions);
```
<!-- example: examples/python/agents.py#get-history -->
```python tab="Python"
entry = agent.history(history_entry_id).get()
if entry.configuration and entry.configuration.guidance:  # the configuration live ran from then on
    print(entry.version, entry.configuration.guidance.instructions)
```
<!-- example: examples/go/agents/agents.go#get-history -->
```go tab="Go"
entry, err := client.Agent(agentID).HistoryEntry(entryID).Get(ctx)
if err != nil {
	return nil, err
}
fmt.Println(entry.ChangedBy.DisplayName, entry.Version)
if entry.Configuration != nil && entry.Configuration.Guidance != nil && entry.Configuration.Guidance.Instructions != nil {
	fmt.Println(*entry.Configuration.Guidance.Instructions)
}
```
<!-- example: examples/rust/src/agents.rs#get-history -->
```rust tab="Rust"
let entry = agent.history_entry(&first.id).get().await?;
println!("{entry:?}");
```

To roll back, publish an earlier version again.

## Start the draft again

[ResetDraftVersion](/reference/reset-draft-version/) starts the draft again from a named version, or from
live, and discards the draft's changes. The version you start from, and live, are untouched.

<!-- example: examples/typescript/agents.ts#reset-draft -->
```ts tab="TypeScript"
const draft = caitlyn.agents(agentId).draft;
// The version the draft starts from, and live, are untouched
const reset = await draft.reset(from, { ifMatch: (await draft.get()).etag });
console.log(`the draft matches ${from} again; its ETag is now ${reset.etag}`);
```
<!-- example: examples/python/agents.py#reset-draft -->
```python tab="Python"
# Start the draft again from a named version (or `live`). Nothing else changes. Send the draft's ETag.
draft = agent.draft.reset(version, if_match=agent.draft.get().etag)
print(draft.based_on)
```
<!-- example: examples/go/agents/agents.go#reset-draft -->
```go tab="Go"
draft := client.Agent(agentID).Draft()
current, err := draft.Get(ctx)
if err != nil {
	return nil, err
}
// The draft starts again from the version in from: a version name, or "live". Nothing else changes.
reset, err := draft.Reset(ctx, &caitlyn.ResetDraftVersionInput{From: from}, caitlyn.WithIfMatch(current.ETag))
if err != nil {
	return nil, err
}
fmt.Println(reset.ETag)
```
<!-- example: examples/rust/src/agents.rs#reset-draft -->
```rust tab="Rust"
let draft = agent.draft().get().await?;
// the draft is live's configuration again
agent.draft().reset("live").if_match(&draft.etag).await?;
```

## Delete a version

[DeleteAgentVersion](/reference/delete-agent-version/) deletes a named version you no longer need. Versions are the
record of what was live, so a version live points at is refused with 409 `VERSION_IN_USE` (point live at another
version first), and one a history entry names with 409 `VERSION_IN_HISTORY`. A saved version that was never
live can be deleted. The draft and live are not named versions, so they cannot be deleted; asking to is refused
with [VERSION_NOT_DELETABLE](/errors/VERSION_NOT_DELETABLE/).

<!-- example: examples/typescript/agents.ts#delete-version -->
```ts tab="TypeScript"
// draft and live have no delete; the version live points at cannot be deleted (409 VERSION_IN_USE)
await caitlyn.agents(agentId).versions(version).delete();
```
<!-- example: examples/python/agents.py#delete-version -->
```python tab="Python"
# Deleting a version that was published does not change what live runs.
agent.versions(name).delete()
```
<!-- example: examples/go/agents/agents.go#delete-version -->
```go tab="Go"
// A version live points at, or one live history names, is refused with a *caitlyn.ConflictError
if _, err := client.Agent(agentID).Version(name).Delete(ctx); err != nil {
	return err
}
```
<!-- example: examples/rust/src/agents.rs#delete-version -->
```rust tab="Rust"
agent.version("checked-2026-11").delete().await?;
```
