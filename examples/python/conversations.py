# The code on the developer docs' pages about the caller, conversations and workspace events, one region each.
# scripts/test-python.sh type-checks this file against the SDK (pyright --strict), and
# scripts/examples-live/python.sh runs each function against a real Caitlyn server.
import os
from collections.abc import Callable

from caitlyn import (
    Caitlyn,
    Caller,
    Conversation,
    MessageCompletedEvent,
    MessageFailedEvent,
    StreamResetEvent,
    TextDeltaEvent,
    WorkspaceConversationCreatedEvent,
    WorkspaceEvent,
)
from caitlyn.auth import Token


def client() -> Caitlyn:
    return Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token(os.environ["CAITLYN_TOKEN"]))


def get_caller(caitlyn: Caitlyn) -> Caller:
    # #region get-caller
    me = caitlyn.callers.get()
    print(me.display_name, me.credential, me.scopes)  # who this credential belongs to, and what it may do
    # #endregion
    return me


def get_agent_version(caitlyn: Caitlyn, agent_id: str) -> str:
    # #region get-agent-version
    draft = caitlyn.agents.versions.get(agent_id=agent_id, version="draft")
    print(draft.configuration.instructions)
    # #endregion
    return draft.name


def create_conversation(caitlyn: Caitlyn, agent_id: str) -> Conversation:
    # #region create-conversation
    conversation = caitlyn.conversations.create(agent_id=agent_id, version="draft", title="Leave questions")
    print(conversation.id)
    # #endregion
    return conversation


def send_message(caitlyn: Caitlyn, conversation_id: str) -> str:
    # #region send-message
    with caitlyn.conversations.send(conversation_id, message="How many days of annual leave do staff get?") as stream:
        for event in stream:
            if isinstance(event, TextDeltaEvent):
                print(event.delta, end="", flush=True)  # the answer as it is written
        answer = stream.final_message()
    print("\n", len(answer.citations or []), "citations")
    # #endregion
    return answer.text


def watch_conversation(caitlyn: Caitlyn, conversation_id: str) -> str:
    # #region watch-conversation
    # The answer being written now, from its start, then every answer after it, until you close the stream.
    text = ""
    with caitlyn.conversations.watch(conversation_id) as stream:
        for event in stream:
            if isinstance(event, TextDeltaEvent):
                text += event.delta
            elif isinstance(event, (MessageCompletedEvent, MessageFailedEvent)):
                break  # this answer is over; leaving the `with` closes the stream
    # #endregion
    return text


def workspace_events(caitlyn: Caitlyn, agent_id: str) -> tuple[WorkspaceEvent | None, str]:
    event: WorkspaceEvent | None = None
    # #region watch-workspace-events
    # Open the stream first, then make the call whose events you want: the stream starts from now.
    with caitlyn.events.subscribe(types=["conversation.created"]) as stream:
        conversation_id = caitlyn.conversations.create(agent_id=agent_id, version="draft").id
        for event in stream:
            if isinstance(event, WorkspaceConversationCreatedEvent) and event.subject.id == conversation_id:
                print("created", event.subject.id, "by", event.actor.type)
                break
    # #endregion
    return event, conversation_id


def stream_reset(
    caitlyn: Caitlyn,
    cursor: str,
    refresh: Callable[[], None],
    handle: Callable[[WorkspaceEvent], None],
    save_cursor: Callable[[str], None],
) -> None:
    """Follows the workspace's new conversations from `cursor`, a saved event ID."""
    # #region stream-reset
    # A cursor more than a day old (or too far behind) is answered with stream.reset, not an error, and the
    # stream carries on from there. The events in between are never sent.
    with caitlyn.events.subscribe(types=["conversation.created"], after=cursor) as stream:
        for event in stream:
            if isinstance(event, StreamResetEvent):
                refresh()  # read again, with the List and Get operations, what you depend on
            else:
                handle(event)
            if event.event_id:
                save_cursor(event.event_id)  # a stream.reset's ID is its new cursor; send it back as `after`
    # #endregion
