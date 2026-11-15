# The code on the developer docs' pages about an agent's versions and production history, one region each.
# scripts/test-python.sh type-checks this file against the SDK (pyright --strict), and
# scripts/examples-live/python.sh runs each function against a real Caitlyn server.
from caitlyn import AgentVersion, Caitlyn, PinDraftVersionResult, ProductionHistoryEntry


def update_draft(caitlyn: Caitlyn, agent_id: str, instructions: str) -> AgentVersion:
    # #region update-draft
    # Read the draft for its ETag, then change only the members you send. A draft someone else changed since
    # you read it is refused with 412, so nobody's edit is lost.
    draft = caitlyn.agents.versions.get(agent_id=agent_id, version="draft")
    draft = caitlyn.agents.versions.update_draft(agent_id, if_match=draft.etag, instructions=instructions)
    print(draft.configuration.instructions)
    # #endregion
    return draft


def pin_draft(caitlyn: Caitlyn, agent_id: str, name: str) -> PinDraftVersionResult:
    # #region pin-draft
    # Keep the draft you tested as a named version. With the draft's ETag, a draft changed since is refused.
    draft = caitlyn.agents.versions.get(agent_id=agent_id, version="draft")
    pinned = caitlyn.agents.versions.pin(agent_id, name=name, if_match=draft.etag, note="Tested with the leave questions")
    print(pinned.name, pinned.created_at)
    # #endregion
    return pinned


def list_versions(caitlyn: Caitlyn, agent_id: str) -> list[str]:
    names: list[str] = []
    # #region list-versions
    # The agent's named versions (the draft and production are not entries). Pages are fetched as needed.
    for version in caitlyn.agents.versions.list(agent_id=agent_id):
        names.append(version.name)
        print(version.name, version.matches_production)
    # #endregion
    return names


def publish_version(caitlyn: Caitlyn, agent_id: str, name: str) -> AgentVersion:
    # #region publish-version
    # Production runs the named version from now on. Send production's ETag, so two publishes cannot overwrite
    # each other; the production it replaces is kept in the production history.
    production = caitlyn.agents.versions.get(agent_id=agent_id, version="production")
    published = caitlyn.agents.versions.publish(agent_id=agent_id, version=name, if_match=production.etag)
    print("production is now", published.based_on)
    # #endregion
    return published


def list_production_history(caitlyn: Caitlyn, agent_id: str) -> list[str]:
    ids: list[str] = []
    # #region list-production-history
    # What production was before each publish, newest first, and who replaced it when.
    for entry in caitlyn.agents.production_history.list(agent_id=agent_id):
        ids.append(entry.id)
        print(entry.version_name, entry.published_at, "until", entry.unpublished_at)
    # #endregion
    return ids


def get_production_history(caitlyn: Caitlyn, agent_id: str, history_entry_id: str) -> ProductionHistoryEntry:
    # #region get-production-history
    entry = caitlyn.agents.production_history.get(agent_id=agent_id, history_entry_id=history_entry_id)
    print(entry.version_name, entry.configuration.instructions)  # production as it was then
    # #endregion
    return entry


def reset_draft(caitlyn: Caitlyn, agent_id: str, version: str) -> AgentVersion:
    # #region reset-draft
    # Start the draft again from a named version (or `production`). Nothing else changes.
    draft = caitlyn.agents.versions.get(agent_id=agent_id, version="draft")
    draft = caitlyn.agents.versions.reset_draft(agent_id, from_=version, if_match=draft.etag)
    print(draft.based_on)
    # #endregion
    return draft


def delete_version(caitlyn: Caitlyn, agent_id: str, name: str) -> None:
    # #region delete-version
    # Deleting a version that was published does not change what production runs.
    caitlyn.agents.versions.delete(agent_id=agent_id, version=name)
    # #endregion
