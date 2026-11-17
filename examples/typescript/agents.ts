// The developer docs show these regions, for an agent, its versions and its live history. Each also runs
// against a real server (scripts/examples-live/typescript.sh), so the code the docs show is code that ran.
import type { Caitlyn, FileInput } from '@caitlyn-ai/sdk';

/** Changes the draft's instructions, sending the draft's ETag so a change made since is not overwritten. */
export async function updateDraft(caitlyn: Caitlyn, agentId: string, instructions: string) {
  // #region update-draft
  const draft = caitlyn.agents(agentId).draft;
  const current = await draft.get();
  // If-Match is optional here; with it, a draft someone changed since is refused with 412: read it again and reapply
  const updated = await draft.update({ guidance: { instructions } }, { ifMatch: current.etag });
  console.log(updated.configuration?.guidance?.instructions, updated.etag);
  // #endregion
  return updated;
}

/** Keeps the draft as a new named version; live does not change. */
export async function pinDraft(caitlyn: Caitlyn, agentId: string, name: string) {
  // #region save-draft-version
  const draft = caitlyn.agents(agentId).draft;
  // With the draft's ETag, only the draft you read is saved
  const saved = await draft.save(name, { note: 'Before the leave policy change' }, { ifMatch: (await draft.get()).etag });
  console.log(`${saved.name} saved at ${saved.createdAt.toISOString()}`);
  // #endregion
  return saved;
}

/** An agent's named versions. The draft and live are scopes of their own: agent.draft and agent.live. */
export async function listVersions(caitlyn: Caitlyn, agentId: string) {
  const names: string[] = [];
  // #region list-versions
  for await (const version of caitlyn.agents(agentId).versions.list()) {
    console.log(version.name, version.matchesLive ? '(live)' : '', version.note ?? '');
    names.push(version.name);
  }
  // #endregion
  return names;
}

/** Publishes a named version: live points at it from now on (a rollback, when live was on it before). */
export async function publishVersion(caitlyn: Caitlyn, agentId: string, version: string) {
  // #region publish-version
  // expectedLive (or If-Match with live's ETag) is an optional check that live has not moved since you looked
  const agent = caitlyn.agents(agentId);
  const live = await agent.live.get();
  const published = await agent.versions(version).publish({ note: 'Leave policy update', expectedLive: live.liveVersion });
  console.log(`live is now ${published.live.version}, ${published.historyEntry.kind} by ${published.live.publishedBy.displayName}`);
  // #endregion
  return published;
}

/** Every change of what live points at: one entry per publish or rollback. */
export async function listHistory(caitlyn: Caitlyn, agentId: string) {
  const ids: string[] = [];
  // #region list-history
  for await (const entry of caitlyn.agents(agentId).history.list()) {
    console.log(`${entry.changedAt.toISOString()}: live moved from ${entry.previousVersion ?? '(nothing)'} to ${entry.version} (${entry.kind})`);
    ids.push(entry.id);
  }
  // #endregion
  return ids;
}

/** One history entry, with the configuration of the version live then pointed at. */
export async function getHistory(caitlyn: Caitlyn, agentId: string, historyEntryId: string) {
  // #region get-history
  const entry = await caitlyn.agents(agentId).history(historyEntryId).get();
  console.log(entry.version, entry.changedBy.displayName, entry.configuration?.guidance?.instructions);
  // #endregion
  return entry;
}

/** Starts the draft again from another version: a named version, or live. */
export async function resetDraft(caitlyn: Caitlyn, agentId: string, from: string) {
  // #region reset-draft
  const draft = caitlyn.agents(agentId).draft;
  // The version the draft starts from, and live, are untouched
  const reset = await draft.reset(from, { ifMatch: (await draft.get()).etag });
  console.log(`the draft matches ${from} again; its ETag is now ${reset.etag}`);
  // #endregion
  return reset;
}

/** Deletes a named version. What live runs does not change. */
export async function deleteVersion(caitlyn: Caitlyn, agentId: string, version: string) {
  // #region delete-version
  // draft and live have no delete; the version live points at cannot be deleted (409 VERSION_IN_USE)
  await caitlyn.agents(agentId).versions(version).delete();
  // #endregion
}

/** Creates an agent whose avatar is a picture: the SDK uploads the file and sends the upload's id. */
export async function createAgentWithPicture(caitlyn: Caitlyn, picture: FileInput) {
  // #region create-agent-picture
  // A PNG, JPEG or WebP of at most 1 MB: a path, a File or UploadFile.fromBytes(…) where the identifier goes
  const agent = await caitlyn.agents.create({ name: 'HR assistant', avatar: { colour: 'sage', mark: { pictureUploadId: picture } } });
  console.log(agent.id, agent.avatar?.mark?.pictureUrl);
  // #endregion
  // #region update-agent-picture
  // A new picture later: the same, on update, with the agent's ETag. The look is not versioned: it changes at once
  const updated = await agent.update({ avatar: { colour: 'sage', mark: { pictureUploadId: picture } } }, { ifMatch: agent.etag });
  // #endregion
  return updated;
}
