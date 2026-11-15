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
  - PinDraftVersion
  - ListAgentVersions
  - PublishAgentVersion
  - ListProductionHistoryEntries
  - GetProductionHistoryEntry
  - ResetDraftVersion
  - DeleteAgentVersion
---

# Change an agent safely

Change an agent's draft, keep the draft you tested as a named version, publish it to production, and roll back
if you need to. Production only changes when you publish, and every change to the draft or to production is
checked against the version you last read, so two people cannot overwrite each other's work.

> **Not available yet.** The SDKs have the agent version operations, but Caitlyn workspaces do not serve them yet.
> This page describes how the SDKs call them.

## Change the draft

Every agent has a draft, which you change, and production, which your users talk to.
[UpdateDraftVersion](/reference/update-draft-version/) changes the draft. Read the draft first and send its
ETag back with the change: if someone else changed the draft in the meantime, the change is refused with 412,
and you read the draft again and reapply it.

<!-- example: examples/typescript/agents.ts#update-draft -->
```ts tab="TypeScript"
const draft = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
// A stale ETag is refused with 412: read the draft again, then reapply the change
const updated = await caitlyn.agents.versions.updateDraft(agentId, { instructions }, { ifMatch: draft.etag });
console.log(updated.configuration.instructions, updated.etag);
```
<!-- example: examples/python/agents.py#update-draft -->
```python tab="Python"
# Read the draft for its ETag, then change only the members you send. A draft someone else changed since
# you read it is refused with 412, so nobody's edit is lost.
draft = caitlyn.agents.versions.get(agent_id=agent_id, version="draft")
draft = caitlyn.agents.versions.update_draft(agent_id, if_match=draft.etag, instructions=instructions)
print(draft.configuration.instructions)
```
<!-- example: examples/go/agents/agents.go#update-draft -->
```go tab="Go"
// Read the draft for its ETag, then change only the fields you set
draft, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
if err != nil {
	return nil, err
}
updated, err := client.Agents.Versions.UpdateDraft(ctx, agentID, &caitlyn.UpdateDraftVersionInput{
	Instructions: caitlyn.Ptr(instructions),
}, caitlyn.WithIfMatch(draft.ETag))
var changed *caitlyn.PreconditionFailedError
if errors.As(err, &changed) {
	return nil, fmt.Errorf("someone else changed the draft: read it again and reapply your change: %w", err)
}
if err != nil {
	return nil, err
}
fmt.Println(updated.ETag) // the new ETag, for the next change
```
<!-- example: examples/rust/src/agents.rs#update-draft -->
```rust tab="Rust"
let draft = client
    .agents()
    .versions()
    .get(GetAgentVersionInput {
        agent_id: agent_id.into(),
        version: "draft".into(),
    })
    .await?;
let input = UpdateDraftVersionInput {
    instructions: Some(instructions.into()),
    ..Default::default()
};
// If-Match: fails with Error::PreconditionFailed if the draft changed after it was read
let updated = client
    .agents()
    .versions()
    .update_draft(agent_id, input)
    .if_match(&draft.etag)
    .await?;
println!("draft now {}", updated.etag);
```

## Keep the draft you tested

Once the draft behaves as you want, keep a copy of it. [PinDraftVersion](/reference/pin-draft-version/) saves
the draft as a new named version, with a note saying why. Send the draft's ETag to pin only the draft you
tested. Pinning does not change production, and the draft carries on as before.

<!-- example: examples/typescript/agents.ts#pin-draft -->
```ts tab="TypeScript"
const draft = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
// With the draft's ETag, only the draft you read is pinned; production does not change
const pinned = await caitlyn.agents.versions.pin(agentId, { name, note: 'Before the leave policy change' }, { ifMatch: draft.etag });
console.log(`${pinned.name} pinned at ${pinned.createdAt.toISOString()}`);
```
<!-- example: examples/python/agents.py#pin-draft -->
```python tab="Python"
# Keep the draft you tested as a named version. With the draft's ETag, a draft changed since is refused.
draft = caitlyn.agents.versions.get(agent_id=agent_id, version="draft")
pinned = caitlyn.agents.versions.pin(agent_id, name=name, if_match=draft.etag, note="Tested with the leave questions")
print(pinned.name, pinned.created_at)
```
<!-- example: examples/go/agents/agents.go#pin-draft -->
```go tab="Go"
draft, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
if err != nil {
	return nil, err
}
// Production does not change, and the draft carries on as before. If-Match pins only the draft you read.
pinned, err := client.Agents.Versions.Pin(ctx, agentID, &caitlyn.PinDraftVersionInput{
	Name: name, // for example "november-release"
	Note: caitlyn.Ptr("Quotes the policy clause it relied on."),
}, caitlyn.WithIfMatch(draft.ETag))
if err != nil {
	return nil, err
}
fmt.Println(pinned.Name, pinned.CreatedAt)
```
<!-- example: examples/rust/src/agents.rs#pin-draft -->
```rust tab="Rust"
let input = PinDraftVersionInput {
    name: name.into(),
    note: Some("Answers checked against the leave policy.".into()),
};
// If-Match pins only the draft you tested; without it, the draft as it is now is pinned
let pinned = client.agents().versions().pin(agent_id, input).if_match(draft_etag).await?;
println!("pinned {} at {}", pinned.name, pinned.created_at);
```

[ListAgentVersions](/reference/list-agent-versions/) lists the agent's named versions, oldest first, and says
which one production matches. The draft and production are not in the list; read them by name with
[GetAgentVersion](/reference/get-agent-version/).

<!-- example: examples/typescript/agents.ts#list-versions -->
```ts tab="TypeScript"
for await (const version of caitlyn.agents.versions.list({ agentId })) {
  console.log(version.name, version.matchesProduction ? '(matches production)' : '', version.note ?? '');
  names.push(version.name);
}
```
<!-- example: examples/python/agents.py#list-versions -->
```python tab="Python"
# The agent's named versions (the draft and production are not entries). Pages are fetched as needed.
for version in caitlyn.agents.versions.list(agent_id=agent_id):
    names.append(version.name)
    print(version.name, version.matches_production)
```
<!-- example: examples/go/agents/agents.go#list-versions -->
```go tab="Go"
var versions []caitlyn.AgentVersionSummary
for version, err := range client.Agents.Versions.List(ctx, &caitlyn.ListAgentVersionsInput{AgentID: agentID}) {
	if err != nil {
		return nil, err
	}
	matches := version.MatchesProduction != nil && *version.MatchesProduction
	fmt.Println(version.Name, version.CreatedAt, matches)
	versions = append(versions, version)
}
```
<!-- example: examples/rust/src/agents.rs#list-versions -->
```rust tab="Rust"
let input = ListAgentVersionsInput {
    agent_id: agent_id.into(),
    ..Default::default()
};
let versions = client.agents().versions().list(input).collect().await?; // every page
for v in &versions {
    println!("{} {:?} based on {:?}", v.name, v.source, v.based_on);
}
```

## Publish

[PublishAgentVersion](/reference/publish-agent-version/) makes production a copy of a named version. Send
production's current ETag, so two publishes cannot overwrite each other. For an agent's first publish, when it
has no production yet, send `*`.

<!-- example: examples/typescript/agents.ts#publish-version -->
```ts tab="TypeScript"
// Send production's current ETag, so two publishes cannot overwrite each other; for an agent's first
// publish, when it has no production yet, send '*'
const production = await caitlyn.agents.versions.get({ agentId, version: 'production' });
const published = await caitlyn.agents.versions.publish({ agentId, version, note: 'Leave policy update' }, { ifMatch: production.etag });
console.log(`production is now ${published.name}, published by ${published.publishedBy?.displayName}`);
```
<!-- example: examples/python/agents.py#publish-version -->
```python tab="Python"
# Production becomes a copy of the named version. Send production's ETag, so two publishes cannot overwrite
# each other; the production it replaces is kept in the production history.
production = caitlyn.agents.versions.get(agent_id=agent_id, version="production")
published = caitlyn.agents.versions.publish(agent_id=agent_id, version=name, if_match=production.etag)
print("production is now", published.based_on)
```
<!-- example: examples/go/agents/agents.go#publish-version -->
```go tab="Go"
// Production's ETag, so two publishes cannot overwrite each other
production, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "production"})
if err != nil {
	return nil, err
}
published, err := client.Agents.Versions.Publish(ctx, &caitlyn.PublishAgentVersionInput{
	AgentID: agentID,
	Version: version, // a version name; rolling back is publishing an earlier one
	Note:    caitlyn.Ptr("Answers leave questions with the clause it relied on."),
}, caitlyn.WithIfMatch(production.ETag))
var changed *caitlyn.PreconditionFailedError
if errors.As(err, &changed) {
	return nil, fmt.Errorf("production changed since you read it: check what is live, then publish again: %w", err)
}
if err != nil {
	return nil, err
}
fmt.Println(published.Name, published.PublishedAt)
```
<!-- example: examples/rust/src/agents.rs#publish-version -->
```rust tab="Rust"
let production = client
    .agents()
    .versions()
    .get(GetAgentVersionInput {
        agent_id: agent_id.into(),
        version: "production".into(),
    })
    .await?;
let input = PublishAgentVersionInput {
    agent_id: agent_id.into(),
    version: version.into(),
    name: None,
    note: Some("Approved for the November release.".into()),
};
// If-Match is production's ETag, so two publishes cannot overwrite each other
let published = client.agents().versions().publish(input).if_match(&production.etag).await?;
println!("production is now {} ({})", published.name, published.etag);
```

## See what was in production

Each publish keeps the production it replaced as a production history entry, with who replaced it and when.
[ListProductionHistoryEntries](/reference/list-production-history-entries/) lists them, and
[GetProductionHistoryEntry](/reference/get-production-history-entry/) reads one with its whole configuration.

<!-- example: examples/typescript/agents.ts#list-production-history -->
```ts tab="TypeScript"
for await (const entry of caitlyn.agents.productionHistory.list({ agentId })) {
  console.log(`${entry.versionName ?? '(unnamed)'} was production until ${entry.unpublishedAt.toISOString()}`);
  ids.push(entry.id);
}
```
<!-- example: examples/python/agents.py#list-production-history -->
```python tab="Python"
# What production was before each publish, newest first, and who replaced it when.
for entry in caitlyn.agents.production_history.list(agent_id=agent_id):
    ids.append(entry.id)
    print(entry.version_name, entry.published_at, "until", entry.unpublished_at)
```
<!-- example: examples/go/agents/agents.go#list-production-history -->
```go tab="Go"
// Newest first: each entry is what production was before a publish, and who replaced it when
var entries []caitlyn.ProductionHistorySummary
input := &caitlyn.ListProductionHistoryEntriesInput{AgentID: agentID}
for entry, err := range client.Agents.ProductionHistory.List(ctx, input) {
	if err != nil {
		return nil, err
	}
	fmt.Println(entry.PublishedAt, entry.UnpublishedAt, entry.UnpublishedBy.DisplayName)
	entries = append(entries, entry)
}
```
<!-- example: examples/rust/src/agents.rs#list-production-history -->
```rust tab="Rust"
let input = ListProductionHistoryEntriesInput {
    agent_id: agent_id.into(),
    limit: Some(10),
    ..Default::default()
};
let page = client.agents().production_history().list_pages(input).next().await.transpose()?; // the latest ten
let entries = page.map(|p| p.items).unwrap_or_default();
for e in &entries {
    println!("{:?} from {} to {}", e.version_name, e.published_at, e.unpublished_at);
}
```
<!-- example: examples/typescript/agents.ts#get-production-history -->
```ts tab="TypeScript"
const entry = await caitlyn.agents.productionHistory.get({ agentId, historyEntryId });
console.log(entry.versionName, entry.configuration.instructions);
```
<!-- example: examples/python/agents.py#get-production-history -->
```python tab="Python"
entry = caitlyn.agents.production_history.get(agent_id=agent_id, history_entry_id=history_entry_id)
print(entry.version_name, entry.configuration.instructions)  # production as it was then
```
<!-- example: examples/go/agents/agents.go#get-production-history -->
```go tab="Go"
entry, err := client.Agents.ProductionHistory.Get(ctx, &caitlyn.GetProductionHistoryEntryInput{
	AgentID:        agentID,
	HistoryEntryID: entryID,
})
if err != nil {
	return nil, err
}
fmt.Println(entry.PublishedBy.DisplayName, entry.Configuration.Instructions)
```
<!-- example: examples/rust/src/agents.rs#get-production-history -->
```rust tab="Rust"
let input = GetProductionHistoryEntryInput {
    agent_id: agent_id.into(),
    history_entry_id: entry_id.into(),
};
let entry = client.agents().production_history().get(input).await?;
println!(
    "{:?} answered until {}: {}",
    entry.version_name, entry.unpublished_at, entry.configuration.instructions
);
```

To roll back, publish an earlier version again.

## Start the draft again

[ResetDraftVersion](/reference/reset-draft-version/) replaces the draft with a copy of a named version, or of
production, and discards the draft's changes. The version copied from, and production, are untouched.

<!-- example: examples/typescript/agents.ts#reset-draft -->
```ts tab="TypeScript"
const draft = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
// The version copied from, and production, are untouched
const reset = await caitlyn.agents.versions.resetDraft(agentId, { from }, { ifMatch: draft.etag });
console.log(`the draft is a copy of ${from} again; its ETag is now ${reset.etag}`);
```
<!-- example: examples/python/agents.py#reset-draft -->
```python tab="Python"
# Start the draft again from a named version (or `production`). Nothing else changes.
draft = caitlyn.agents.versions.get(agent_id=agent_id, version="draft")
draft = caitlyn.agents.versions.reset_draft(agent_id, from_=version, if_match=draft.etag)
print(draft.based_on)
```
<!-- example: examples/go/agents/agents.go#reset-draft -->
```go tab="Go"
draft, err := client.Agents.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: agentID, Version: "draft"})
if err != nil {
	return nil, err
}
// The draft becomes a copy of from: a version name, or "production". Nothing else changes.
reset, err := client.Agents.Versions.ResetDraft(ctx, agentID, &caitlyn.ResetDraftVersionInput{From: from},
	caitlyn.WithIfMatch(draft.ETag))
if err != nil {
	return nil, err
}
fmt.Println(reset.ETag)
```
<!-- example: examples/rust/src/agents.rs#reset-draft -->
```rust tab="Rust"
let input = ResetDraftVersionInput { from: from.into() }; // a version name, or production
let draft = client.agents().versions().reset_draft(agent_id, input).if_match(draft_etag).await?;
println!("draft reset from {from}: {}", draft.etag);
```

## Delete a version

[DeleteAgentVersion](/reference/delete-agent-version/) deletes a named version you no longer need. Production
keeps what was published, even when the version it was published from is deleted. The draft and production
are not named versions, so they cannot be deleted; asking to is refused with
[VERSION_NOT_DELETABLE](/errors/VERSION_NOT_DELETABLE/).

<!-- example: examples/typescript/agents.ts#delete-version -->
```ts tab="TypeScript"
// draft and production cannot be deleted (400 VERSION_NOT_DELETABLE)
await caitlyn.agents.versions.delete({ agentId, version });
```
<!-- example: examples/python/agents.py#delete-version -->
```python tab="Python"
# Production is its own copy, so deleting a version that was published does not change it.
caitlyn.agents.versions.delete(agent_id=agent_id, version=name)
```
<!-- example: examples/go/agents/agents.go#delete-version -->
```go tab="Go"
// Production is its own copy, so deleting the version it came from does not change it
_, err := client.Agents.Versions.Delete(ctx, &caitlyn.DeleteAgentVersionInput{AgentID: agentID, Version: name})
if err != nil {
	return err
}
```
<!-- example: examples/rust/src/agents.rs#delete-version -->
```rust tab="Rust"
let input = DeleteAgentVersionInput {
    agent_id: agent_id.into(),
    version: version.into(),
};
let deleted = client.agents().versions().delete(input).await?;
println!("deleted {version} ({:?})", deleted.request_id);
```
