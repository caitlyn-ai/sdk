"""The checks scripts/examples-live/python.sh runs: each calls one function from conversations.py, documents.py or
agents.py (the docs' code) against the server, with the client pointed at CAITLYN_ENDPOINT. Prints exactly one line
per check on stdout, `ok <check>`, `fail <check>: <why>` or `skip <check>: <why>`; what the examples themselves print
goes to stderr. A check skips only without CAITLYN_KNOWLEDGE_BASE_ID or CAITLYN_PUBLISH_AGENT_ID; a 403 is a failure (the
shared runner decides about the "public" role). The agent checks put the draft back and delete the version they save."""

from __future__ import annotations

import contextlib
import os
import secrets
import signal
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from types import FrameType
from typing import Any

import agents
import conversations as ex
import documents
import jobs
from caitlyn import AgentGuidance, AgentVersion, Caitlyn, KnowledgeBaseScope, MessageStartedEvent, NotFoundError, PermissionDeniedError, WorkspaceConversationCreatedEvent, WorkspaceEvent
from caitlyn.auth import Token

TIMEOUT_SECONDS = 120
WAIT_SECONDS = 900  # a short text file indexes in minutes
caitlyn = Caitlyn(workspace=os.environ["CAITLYN_WORKSPACE"], endpoint=os.environ["CAITLYN_ENDPOINT"], auth=Token(os.environ["CAITLYN_TOKEN"]))
agent_id = os.environ["CAITLYN_AGENT_ID"]
knowledge_base_id = os.environ.get("CAITLYN_KNOWLEDGE_BASE_ID") or None  # an empty value counts as unset
publish_agent_id = os.environ.get("CAITLYN_PUBLISH_AGENT_ID") or None
failed = False


class TimedOut(Exception):
    pass


class Skip(Exception):
    """The check cannot run against this workspace. Only two reasons are allowed (CONTRIBUTING.md): no knowledge
    base configured, and publishing turned off. Any other problem is a failure."""


NO_KNOWLEDGE_BASE = "no knowledge base configured"
NO_PUBLISHING = "publishing turned off"


def _alarm(signum: int, frame: FrameType | None) -> None:
    raise TimedOut("no result in time")


signal.signal(signal.SIGALRM, _alarm)


def check(name: str, run: Callable[[], str | None], seconds: int = TIMEOUT_SECONDS) -> None:
    """Runs one check. `run` returns None when the check passes, or why it failed, or raises Skip."""
    global failed
    signal.alarm(seconds)
    verdict = "ok"
    why: str | None = None
    try:
        with contextlib.redirect_stdout(sys.stderr):
            why = run()
        if why is not None:
            verdict = "fail"
    except Skip as e:
        verdict, why = "skip", str(e)
    except PermissionDeniedError as e:
        # Always a failure here; the shared runner decides whether a refusal for the "public" role counts as a skip.
        verdict, why = "fail", f"403 {e.code}: {e.detail or e.title}"
    except Exception as e:  # noqa: BLE001 - every failure is reported as the check's result
        verdict, why = "fail", f"{type(e).__name__}: {e}"
    finally:
        signal.alarm(0)
    if verdict == "fail":
        failed = True
    line = name if verdict == "ok" else f"{name}: {(why or '').replace(chr(10), ' ')}"
    print(f"{verdict} {line}", flush=True)


def uuid7_at(seconds_ago: float) -> str:
    """A UUIDv7 event cursor for a moment in the past."""
    ms = int((time.time() - seconds_ago) * 1000)
    value = (ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | secrets.randbits(12) << 64 | 0b10 << 62 | secrets.randbits(62)
    return str(uuid.UUID(int=value))


def get_caller() -> str | None:
    me = ex.get_caller(caitlyn)
    return None if me.display_name and me.credential else f"incomplete caller {me.raw}"


def get_agent_version() -> str | None:
    name = ex.get_agent_version(caitlyn, agent_id)
    return None if name == "draft" else f"asked for the draft, got {name!r}"


def create_conversation() -> str | None:
    c = ex.create_conversation(caitlyn, agent_id)
    if c.result.agent_id != agent_id or c.result.version != "draft":
        return f"conversation for {c.result.agent_id} {c.result.version}"
    return None if c.result.response_metadata and c.result.response_metadata.http_status_code == 201 else f"status {c.result.response_metadata}"


def send_message() -> str | None:
    c = caitlyn.agents(agent_id).draft.conversations.create()
    text = ex.send_message(caitlyn, c.id)
    return None if text.strip() else "the answer was empty"


def watch_conversation() -> str | None:
    """Watches a conversation while SendMessage, in another thread, has an answer in progress."""
    c = caitlyn.agents(agent_id).draft.conversations.create()
    started = threading.Event()
    sent: dict[str, Any] = {}

    def send() -> None:
        try:
            with c.send("In one sentence, what can you help me with?") as stream:
                for event in stream:
                    if isinstance(event, MessageStartedEvent):
                        started.set()
                sent["text"] = stream.final_message().text
        except Exception as e:  # noqa: BLE001
            sent["error"] = e
        finally:
            started.set()

    sender = threading.Thread(target=send, daemon=True)
    sender.start()
    started.wait(TIMEOUT_SECONDS)
    if "error" in sent:
        return f"SendMessage failed: {sent['error']}"
    watched = ex.watch_conversation_events(caitlyn, c.id)
    sender.join(TIMEOUT_SECONDS)
    if "text" not in sent:
        return f"SendMessage did not finish: {sent.get('error')}"
    if not watched.strip():
        return "watched no text"
    return None if watched == sent["text"] else f"watched {len(watched)} characters, the answer has {len(sent['text'])}"


def workspace_events() -> str | None:
    event, conversation_id = ex.workspace_events(caitlyn, agent_id)
    if not isinstance(event, WorkspaceConversationCreatedEvent):
        return f"the stream ended without conversation.created (last event: {event})"
    return None if event.subject.id == conversation_id and event.subject.type == "conversation" else f"unexpected subject {event.subject}"


class _Stop(Exception):
    """Ends the stream-reset example once the check has what it needs."""


def stream_reset() -> str | None:
    """A two-day-old cursor: stream.reset arrives first, with a new cursor, and the stream then carries on."""
    old = uuid7_at(2 * 24 * 3600)
    log: list[str] = []
    created: dict[str, str] = {}

    def refresh() -> None:
        log.append("refresh")
        # Something to carry on to: a conversation created after the reset.
        created["id"] = caitlyn.agents(agent_id).draft.conversations.create().id

    def handle(event: WorkspaceEvent) -> None:
        log.append(f"handle {event.type}")
        if isinstance(event, WorkspaceConversationCreatedEvent) and event.subject.id == created.get("id"):
            raise _Stop

    def save_cursor(cursor: str) -> None:
        log.append(f"cursor {'old' if cursor == old else 'new'}")

    try:
        ex.stream_reset(caitlyn, old, refresh, handle, save_cursor)
    except _Stop:
        pass
    if log[:2] != ["refresh", "cursor new"]:
        return f"stream.reset did not come first with a new cursor: {log[:3]}"
    if log[-1] != "handle conversation.created":
        return f"the stream did not carry on after stream.reset: {log}"
    return None


# ------------------------------------------------------------------ uploads and documents

LEAVE_POLICY = Path(__file__).resolve().parents[1] / "fixtures" / "leave-policy.pdf"
"""A one-page leave policy: a file type a knowledge base can ingest."""
RUN_ID = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(3)}"
FOLDER = "/policies/"
"""The docs' folder, which the regions name. Each run's documents are told apart by name."""
FIRST_NAME = f"leave-policy-{RUN_ID}.pdf"
SECOND_NAME = f"leave-policy-{RUN_ID}-2.pdf"
THIRD_NAME = f"leave-policy-{RUN_ID}-3.pdf"


def run_copy(name: str) -> Path:
    """The leave policy PDF under this run's own name: the uploaded file's name becomes the document's."""
    path = Path(os.environ.get("TMPDIR", "/tmp")) / name
    path.write_bytes(LEAVE_POLICY.read_bytes())
    return path
state: dict[str, Any] = {}


def create_upload() -> str | None:
    upload = jobs.send_upload(caitlyn, run_copy(FIRST_NAME))
    state["upload"] = upload.id
    return None if upload.id else "no upload id"


def get_upload() -> str | None:
    if "upload" not in state:
        return "CreateUpload did not give an upload to read"
    upload = documents.get_upload(caitlyn, state["upload"])
    return None if upload.id == state["upload"] else f"got upload {upload.id}"


def need_knowledge_base() -> KnowledgeBaseScope:
    if knowledge_base_id is None:
        raise Skip(NO_KNOWLEDGE_BASE)
    return caitlyn.knowledge_bases(knowledge_base_id)


def create_document() -> str | None:
    kb = need_knowledge_base()
    if "upload" not in state:
        return "CreateUpload did not give an upload to add"
    created = documents.create_document(kb, state["upload"])
    state["document"] = created.id
    remember(created.id)
    return None if created.document.knowledge_base_id == kb.id else f"document in {created.document.knowledge_base_id}"


def delete_processing_document() -> str | None:
    """A document still being processed can be deleted: a third document is deleted the moment it is created, the delete
    is accepted, its wait ends once the document is gone, and the document does not come back."""
    kb = need_knowledge_base()
    third = kb.documents.create(run_copy(THIRD_NAME), folder=FOLDER)
    remember(third.id)
    third.delete().wait(timeout=WAIT_SECONDS)
    try:
        third.get()
        return "the document can still be read after its delete"
    except NotFoundError:
        pass
    forget(third.id)
    names = [doc.id for doc in kb.documents.list(folder=FOLDER)]
    return None if third.id not in names else "the deleted document is listed again"


def get_document() -> str | None:
    kb = need_knowledge_base()
    if "document" not in state:
        return "CreateDocument did not give a document to read"
    doc = documents.get_document(kb, state["document"])
    return None if doc.id == state["document"] else f"got document {doc.id}"


def wait_for_document() -> str | None:
    kb = need_knowledge_base()
    if "document" not in state:
        return "CreateDocument did not give a document to read"
    doc = documents.wait_until_indexed(kb, state["document"])
    return None if doc.status in ("indexed", "partially_indexed") else f"ended at {doc.status}"


def list_documents() -> str | None:
    """Lists the docs' folder with no status filter, so the check shows whether listing works whatever indexing did
    (the docs' region also filters on `indexed`, which a review environment may never reach)."""
    kb = need_knowledge_base()
    if "document" not in state:
        return "CreateDocument did not give a document to list"
    names = [doc.name for doc in kb.documents.list(folder=FOLDER)]
    return None if FIRST_NAME in names else f"{FIRST_NAME} is not among the {len(names)} documents in {FOLDER}"


created_documents: list[str] = []
"""Every document the run created and has not seen deleted; the clean-up deletes what is left."""


def remember(document_id: str) -> None:
    created_documents.append(document_id)


def forget(document_id: str) -> None:
    if document_id in created_documents:
        created_documents.remove(document_id)


def delete_document() -> str | None:
    kb = need_knowledge_base()
    if "document" not in state:
        return "CreateDocument did not give a document to delete"
    kb.documents(state["document"]).delete()
    return None


@contextlib.contextmanager
def log_status_changes(kb: KnowledgeBaseScope, document_id: str) -> Iterator[None]:
    """Diagnostics, not a check: prints each change in a document's status to stderr, read every 15 s while the
    block runs, so a delete that does not finish shows what the document did instead."""
    stop = threading.Event()

    def watch() -> None:
        started, last = time.monotonic(), ""
        while not stop.is_set():
            try:
                d = kb.documents(document_id).get()
                now = " ".join(str(v) for v in (d.status, d.processing.stage if d.processing else None, d.failure.code if d.failure else None) if v)
            except NotFoundError:
                now = "404"
            except Exception as err:  # diagnostics only: any other error is shown by its type
                now = f"error {type(err).__name__}"
            if now != last and not stop.is_set():
                print(f"status: {document_id} at {round(time.monotonic() - started)} s: {now}", file=sys.stderr)
                last = now
            stop.wait(15)

    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()


def batch_delete_documents() -> str | None:
    """A second document, from a new upload, deleted in a batch with an identifier that does not exist."""
    kb = need_knowledge_base()
    second = kb.documents.create(run_copy(SECOND_NAME), folder=FOLDER).id
    remember(second)
    missing = second[:-1] + ("0" if second[-1] != "0" else "1")  # same shape, no such document
    with log_status_changes(kb, second):
        batch = documents.delete_many(kb, [second, missing])
        got = [(r.document_id, str(r.status), r.code) for r in batch.results]
        want = [(second, "accepted", None), (missing, "failed", "NOT_FOUND")]
        if got != want:
            return f"results {got}, expected {want}"
        with contextlib.suppress(NotFoundError):  # it is gone once its wait ends in a 404
            kb.documents(second).wait(timeout=WAIT_SECONDS)
    forget(second)
    return None


def delete_document_wait() -> str | None:
    kb = need_knowledge_base()
    if "document" not in state:
        return "CreateDocument did not give a document to wait for"
    try:
        kb.documents(state["document"]).wait(timeout=WAIT_SECONDS)
    except NotFoundError:
        pass  # gone already
    forget(state["document"])
    return None


def delete_leftover_documents() -> None:
    """Deletes, and waits for, every document the run created and did not see deleted. A failure is printed to
    stderr, not as a check line, so a document left in the knowledge base shows in the log without failing the run;
    each document is waited for on its own, so one failure does not stop the rest."""
    if knowledge_base_id is None or not created_documents:
        return
    leftover = list(created_documents)
    kb = caitlyn.knowledge_bases(knowledge_base_id)
    try:
        batch = kb.documents.delete_many(leftover)
        for result in batch.results:
            if result.status != "accepted":
                print(f"clean-up: {result.document_id} was not deleted: {result.code} {result.detail or ''}".rstrip(), file=sys.stderr)
    except Exception as e:  # noqa: BLE001 - reported, then each document is still waited for
        print(f"clean-up: the batch delete of {leftover} failed: {type(e).__name__}: {e}", file=sys.stderr)
    for document_id in leftover:
        try:
            kb.documents(document_id).wait(timeout=300)
        except NotFoundError:
            pass  # gone
        except Exception as e:  # noqa: BLE001
            print(f"clean-up: {document_id} may be left in the knowledge base: {type(e).__name__}: {e}", file=sys.stderr)


# ------------------------------------------------------------------ agent versions (put back as they were)

def instructions_of(version: AgentVersion) -> str | None:
    guidance = version.configuration.guidance if version.configuration else None
    return guidance.instructions if guidance else None


saved_name = f"sdk-python-check-{secrets.token_hex(3)}"
original: str | None = None
"""The draft's instructions before the agent checks, read by SaveDraftVersion."""
restored = False
saved = False


def save_draft() -> str | None:
    global saved, original
    original = instructions_of(caitlyn.agents(agent_id).draft.get())
    result = agents.save_draft(caitlyn.agents(agent_id), saved_name)
    saved = True
    return None if result.name == saved_name and instructions_of(result) == original else f"saved {result.name}"


def update_draft() -> str | None:
    if not saved or original is None:
        return "SaveDraftVersion did not save the draft, so it could not be put back; not changed"
    changed = original + "\n\n(Checked by the Python SDK's examples.)"
    draft = agents.update_draft(caitlyn.agents(agent_id), changed)
    return None if instructions_of(draft) == changed else "the draft did not change"


def list_versions() -> str | None:
    # The list holds named versions only: the draft and live are not entries.
    if not saved:
        return "SaveDraftVersion did not save a version to look for"
    names = agents.list_versions(caitlyn.agents(agent_id))
    return None if saved_name in names else f"the saved version {saved_name} is not listed"


def publish_version() -> str | None:
    """On the publish agent only: save its draft under a unique name, publish that (a rollback's shape), check the
    history entry, then delete the saved version (live keeps what was published)."""
    if publish_agent_id is None:
        raise Skip(NO_PUBLISHING)
    agent = caitlyn.agents(publish_agent_id)
    name = f"sdk-python-publish-{secrets.token_hex(3)}"
    agent.draft.save(name)
    try:
        published = agent.versions(name).publish()
    finally:
        agent.versions(name).delete()
    return None if published.history_entry.version == name else f"live history names {published.history_entry.version}"


def list_history() -> str | None:
    agents.list_history(caitlyn.agents(agent_id))  # an empty history is a pass: the call returned a page
    return None


def get_history() -> str | None:
    """Entries come from publishing, so this reads the publish agent's history."""
    if publish_agent_id is None:
        raise Skip(NO_PUBLISHING)
    ids = agents.list_history(caitlyn.agents(publish_agent_id))
    if not ids:
        return "the publish agent has no live history, even after PublishAgentVersion"
    entry = agents.get_history(caitlyn.agents(publish_agent_id), ids[0])
    return None if entry.id == ids[0] else f"got entry {entry.id}"


def reset_draft() -> str | None:
    global restored
    if not saved:
        return "SaveDraftVersion did not save a version to reset from"
    draft = agents.reset_draft(caitlyn.agents(agent_id), saved_name)
    restored = instructions_of(draft) == original
    return None if restored else "the draft does not match the saved version"


def delete_version() -> str | None:
    global saved
    if not saved:
        return "SaveDraftVersion did not save a version to delete"
    agents.delete_version(caitlyn.agents(agent_id), saved_name)
    saved = False
    names = agents.list_versions(caitlyn.agents(agent_id))
    return None if saved_name not in names else "the version is still listed"


def put_back() -> None:
    """If a check failed part way, the draft and the saved version are put back regardless."""
    with contextlib.suppress(Exception):
        if not restored and original is not None:
            draft = caitlyn.agents(agent_id).draft.get()
            if instructions_of(draft) != original:
                caitlyn.agents(agent_id).draft.update(if_match=draft.etag, guidance=AgentGuidance(instructions=original))
    with contextlib.suppress(Exception):
        if saved:
            caitlyn.agents(agent_id).versions(saved_name).delete()


CHECKS: list[tuple[str, Callable[[], str | None], int]] = [
    ("GetCaller", get_caller, TIMEOUT_SECONDS),
    ("GetAgentVersion", get_agent_version, TIMEOUT_SECONDS),
    ("CreateConversation", create_conversation, TIMEOUT_SECONDS),
    ("SendMessage", send_message, TIMEOUT_SECONDS),
    ("WatchConversation", watch_conversation, TIMEOUT_SECONDS),
    ("WatchWorkspaceEvents", workspace_events, TIMEOUT_SECONDS),
    ("stream.reset", stream_reset, TIMEOUT_SECONDS),
    ("CreateUpload", create_upload, TIMEOUT_SECONDS),
    ("GetUpload", get_upload, TIMEOUT_SECONDS),
    ("CreateDocument", create_document, TIMEOUT_SECONDS),
    ("DeleteDocument.processing", delete_processing_document, TIMEOUT_SECONDS),
    ("GetDocument", get_document, TIMEOUT_SECONDS),
    ("Document.wait", wait_for_document, WAIT_SECONDS),
    ("ListDocuments", list_documents, TIMEOUT_SECONDS),
    ("DeleteDocument", delete_document, TIMEOUT_SECONDS),
    ("BatchDeleteDocuments", batch_delete_documents, WAIT_SECONDS),
    ("DeleteDocument.wait", delete_document_wait, WAIT_SECONDS),
    ("SaveDraftVersion", save_draft, TIMEOUT_SECONDS),
    ("UpdateDraftVersion", update_draft, TIMEOUT_SECONDS),
    ("ListAgentVersions", list_versions, TIMEOUT_SECONDS),
    ("PublishAgentVersion", publish_version, TIMEOUT_SECONDS),
    ("ListHistoryEntries", list_history, TIMEOUT_SECONDS),
    ("GetHistoryEntry", get_history, TIMEOUT_SECONDS),
    ("ResetDraftVersion", reset_draft, TIMEOUT_SECONDS),
    ("DeleteAgentVersion", delete_version, TIMEOUT_SECONDS),
]
try:
    for name, run, seconds in CHECKS:
        check(name, run, seconds)
finally:
    put_back()
    delete_leftover_documents()
    caitlyn.close()
sys.exit(1 if failed else 0)
