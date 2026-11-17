# The code on the developer docs' pages about an agent's draft, versions and live history, one region each.
# scripts/test-python.sh type-checks this file against the SDK (pyright --strict), and
# scripts/examples-live/python.sh runs each function against a real Caitlyn server. In every region `agent` is
# `caitlyn.agents(agent_id)`.
from pathlib import Path

from caitlyn import (
    Agent,
    AgentAvatarInput,
    AgentGuidance,
    AgentMarkInput,
    AgentScope,
    AgentVersion,
    CompareAgentVersionsResult,
    HistoryEntry,
    PublishAgentVersionResult,
    UploadFile,
)


def update_draft(agent: AgentScope, instructions: str) -> AgentVersion:
    # #region update-draft
    # Change only the members you send. With the draft's ETag (if_match=), a draft someone else changed since you
    # read it is refused with 412; without it, the change applies to the draft as it is.
    draft = agent.draft.update(guidance=AgentGuidance(instructions=instructions))
    if draft.configuration and draft.configuration.guidance:
        print(draft.configuration.guidance.instructions)
    # #endregion
    return draft


def save_draft(agent: AgentScope, name: str) -> AgentVersion:
    # #region save-draft-version
    # Keep the draft you tested as a named version; live does not change.
    saved = agent.draft.save(name, note="Tested with the leave questions")
    print(saved.name, saved.created_at)
    # #endregion
    return saved


def compare_draft(agent: AgentScope) -> CompareAgentVersionsResult:
    # #region compare-draft
    # What publishing the draft would change.
    changes = agent.draft.compare("live")
    for change in changes.changes:
        print(change.path)
    # #endregion
    return changes


def publish_version(agent: AgentScope, name: str) -> PublishAgentVersionResult:
    # #region publish-version
    # Live runs the named version from now on, and the move is kept in the live history. A version that was live
    # before is a rollback. expected_live= (or if_match= with live's ETag) refuses it if live moved meanwhile.
    published = agent.versions(name).publish()
    print("live is now", published.live.version, published.history_entry.kind)
    # #endregion
    return published


def list_versions(agent: AgentScope) -> list[str]:
    names: list[str] = []
    # #region list-versions
    # The agent's named versions (the draft and live are not entries). Pages are fetched as needed.
    for version in agent.versions.list():
        names.append(version.name)
        print(version.name, version.matches_live)
    # #endregion
    return names


def list_history(agent: AgentScope) -> list[str]:
    ids: list[str] = []
    # #region list-history
    # Each time live moved to another version, newest first: by a publish or a rollback, who did it and when.
    for entry in agent.history.list():
        ids.append(entry.id)
        print(entry.kind, entry.previous_version, "->", entry.version, entry.changed_at)
    # #endregion
    return ids


def get_history(agent: AgentScope, history_entry_id: str) -> HistoryEntry:
    # #region get-history
    entry = agent.history(history_entry_id).get()
    if entry.configuration and entry.configuration.guidance:  # the configuration live ran from then on
        print(entry.version, entry.configuration.guidance.instructions)
    # #endregion
    return entry


def reset_draft(agent: AgentScope, version: str) -> AgentVersion:
    # #region reset-draft
    # Start the draft again from a named version (or `live`). Nothing else changes. Send the draft's ETag.
    draft = agent.draft.reset(version, if_match=agent.draft.get().etag)
    print(draft.based_on)
    # #endregion
    return draft


def delete_version(agent: AgentScope, name: str) -> None:
    # #region delete-version
    # Deleting a version that was published does not change what live runs.
    agent.versions(name).delete()
    # #endregion


def update_agent_picture(agent: AgentScope, picture: Path) -> Agent:
    # #region update-agent-picture
    # The agent's look is not versioned: it changes everywhere at once. Send the agent's ETag.
    updated = agent.update(if_match=agent.get().etag, avatar=AgentAvatarInput(mark=AgentMarkInput(picture_upload_id=UploadFile.from_path(picture))))
    print(updated.avatar)
    # #endregion
    return updated
