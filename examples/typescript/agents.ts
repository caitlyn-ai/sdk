// The developer docs show these regions, for an agent's versions and its production history. Each also runs
// against a real server (scripts/examples-live/typescript.sh), so the code the docs show is code that ran.
import type { Caitlyn } from '@caitlyn-ai/sdk';

/** Changes the draft's instructions, sending the draft's ETag so a change made since is not overwritten. */
export async function updateDraft(caitlyn: Caitlyn, agentId: string, instructions: string) {
  // #region update-draft
  const draft = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
  // A stale ETag is refused with 412: read the draft again, then reapply the change
  const updated = await caitlyn.agents.versions.updateDraft(agentId, { instructions }, { ifMatch: draft.etag });
  console.log(updated.configuration.instructions, updated.etag);
  // #endregion
  return updated;
}

/** Keeps a copy of the draft as a new named version, pinning exactly the draft that was read. */
export async function pinDraft(caitlyn: Caitlyn, agentId: string, name: string) {
  // #region pin-draft
  const draft = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
  // With the draft's ETag, only the draft you read is pinned; production does not change
  const pinned = await caitlyn.agents.versions.pin(agentId, { name, note: 'Before the leave policy change' }, { ifMatch: draft.etag });
  console.log(`${pinned.name} pinned at ${pinned.createdAt.toISOString()}`);
  // #endregion
  return pinned;
}

/** An agent's named versions. The draft and production are not entries: read them with versions.get. */
export async function listVersions(caitlyn: Caitlyn, agentId: string) {
  const names: string[] = [];
  // #region list-versions
  for await (const version of caitlyn.agents.versions.list({ agentId })) {
    console.log(version.name, version.matchesProduction ? '(matches production)' : '', version.note ?? '');
    names.push(version.name);
  }
  // #endregion
  return names;
}

/** Publishes a named version: production becomes a copy of it. */
export async function publishVersion(caitlyn: Caitlyn, agentId: string, version: string) {
  // #region publish-version
  // Send production's current ETag, so two publishes cannot overwrite each other; for an agent's first
  // publish, when it has no production yet, send '*'
  const production = await caitlyn.agents.versions.get({ agentId, version: 'production' });
  const published = await caitlyn.agents.versions.publish({ agentId, version, note: 'Leave policy update' }, { ifMatch: production.etag });
  console.log(`production is now ${published.name}, published by ${published.publishedBy?.displayName}`);
  // #endregion
  return published;
}

/** What production was before each publish: one entry per replaced production. */
export async function listProductionHistory(caitlyn: Caitlyn, agentId: string) {
  const ids: string[] = [];
  // #region list-production-history
  for await (const entry of caitlyn.agents.productionHistory.list({ agentId })) {
    console.log(`${entry.versionName ?? '(unnamed)'} was production until ${entry.unpublishedAt.toISOString()}`);
    ids.push(entry.id);
  }
  // #endregion
  return ids;
}

/** One production history entry, with the configuration production had then. */
export async function getProductionHistory(caitlyn: Caitlyn, agentId: string, historyEntryId: string) {
  // #region get-production-history
  const entry = await caitlyn.agents.productionHistory.get({ agentId, historyEntryId });
  console.log(entry.versionName, entry.configuration.instructions);
  // #endregion
  return entry;
}

/** Resets the draft to a copy of another version: a named version, or production. */
export async function resetDraft(caitlyn: Caitlyn, agentId: string, from: string) {
  // #region reset-draft
  const draft = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
  // The version copied from, and production, are untouched
  const reset = await caitlyn.agents.versions.resetDraft(agentId, { from }, { ifMatch: draft.etag });
  console.log(`the draft is a copy of ${from} again; its ETag is now ${reset.etag}`);
  // #endregion
  return reset;
}

/** Deletes a named version. Production is its own copy, so it does not change. */
export async function deleteVersion(caitlyn: Caitlyn, agentId: string, version: string) {
  // #region delete-version
  // draft and production cannot be deleted (400 VERSION_NOT_DELETABLE)
  await caitlyn.agents.versions.delete({ agentId, version });
  // #endregion
}
