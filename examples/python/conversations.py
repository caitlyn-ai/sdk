# The code on the developer docs' pages about the caller, conversations and workspace events, one region each.
# scripts/test-python.sh type-checks this file against the SDK (pyright --strict), and
# scripts/examples-live/python.sh runs each function against a real Caitlyn server.
import os
from collections.abc import Callable
from pathlib import Path

from caitlyn import (
    Caitlyn,
    Caller,
    CreatedConversationScope,
    MessageCompletedEvent,
    MessageFailedEvent,
    StreamResetEvent,
    TextDeltaEvent,
    WorkspaceConversationCreatedEvent,
    WorkspaceEvent,
)
from caitlyn.auth import Token


def client() -> Caitlyn:
    return Caitlyn(workspace="your-company.caitlyn.ai", auth=Token(os.environ["CAITLYN_TOKEN"]))


def get_caller(caitlyn: Caitlyn) -> Caller:
    # #region get-caller
    me = caitlyn.me()
    print(me.display_name, me.credential, me.scopes)  # who this credential belongs to, and what it may do
    # #endregion
    return me


def get_agent_version(caitlyn: Caitlyn, agent_id: str) -> str:
    # #region get-agent-version
    draft = caitlyn.agents(agent_id).draft.get()
    print(draft.configuration.guidance.instructions if draft.configuration and draft.configuration.guidance else "")
    # #endregion
    return draft.name


def create_conversation(caitlyn: Caitlyn, agent_id: str) -> CreatedConversationScope:
    # #region create-conversation
    # A conversation is with one version of an agent: start it from that version (here the draft, to test it).
    conversation = caitlyn.agents(agent_id).draft.conversations.create(title="Leave questions")
    print(conversation.id)
    # #endregion
    return conversation


def send_message(caitlyn: Caitlyn, conversation_id: str) -> str:
    # #region send-message
    # The message is sent when send() is called; the stream may be read or dropped.
    with caitlyn.conversations(conversation_id).send("How many days of annual leave do staff get?") as stream:
        for event in stream:
            if isinstance(event, TextDeltaEvent):
                print(event.delta, end="", flush=True)  # the answer as it is written
        answer = stream.final_message()
    print("\n", len(answer.citations or []), "citations")
    # #endregion
    return answer.text


def list_messages(caitlyn: Caitlyn, conversation_id: str) -> list[str]:
    ids: list[str] = []
    # #region list-messages
    # The conversation's earlier turns.
    for message in caitlyn.conversations(conversation_id).messages.list():
        ids.append(message.id)
    # #endregion
    return ids


def watch_conversation_events(caitlyn: Caitlyn, conversation_id: str) -> str:
    # #region watch-conversation
    # The answer being written now, from its start, then every answer after it, until you close the stream.
    text = ""
    with caitlyn.conversations(conversation_id).watch() as stream:
        for event in stream:
            if isinstance(event, TextDeltaEvent):
                text += event.delta
            elif isinstance(event, (MessageCompletedEvent, MessageFailedEvent)):
                break  # this answer is over; leaving the `with` closes the stream
    # #endregion
    return text


def send_attachments(caitlyn: Caitlyn, conversation_id: str, form: Path) -> str:
    # #region send-attachments
    # Documents the message carries: each file is uploaded first, for this conversation, then the message names them
    # in your order. An upload already sent goes as UploadId("…"). If a file fails to upload, no message is sent.
    with caitlyn.conversations(conversation_id).send("Does this leave form match our policy?", attachments=[form]) as stream:
        answer = "".join(stream.text())
    # #endregion
    return answer


def workspace_events(caitlyn: Caitlyn, agent_id: str) -> tuple[WorkspaceEvent | None, str]:
    event: WorkspaceEvent | None = None
    # #region watch-workspace-events
    # Open the stream first, then make the call whose events you want: the stream starts from now.
    with caitlyn.events.watch(types=["conversation.created"]) as stream:
        conversation_id = caitlyn.agents(agent_id).draft.conversations.create().id
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
    with caitlyn.events.watch(types=["conversation.created"], after=cursor) as stream:
        for event in stream:
            if isinstance(event, StreamResetEvent):
                refresh()  # read again, with the List and Get operations, what you depend on
            else:
                handle(event)
            if event.event_id:
                save_cursor(event.event_id)  # a stream.reset's ID is its new cursor; send it back as `after`
    # #endregion
