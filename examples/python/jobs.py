# The ten jobs on the developer docs' landing page, and the jobs that cost money, one region each, with the same
# region names in every language. scripts/test-python.sh type-checks this file against the SDK (pyright --strict).
# In every region `kb` is `caitlyn.knowledge_bases(kb_id)`: a scope, which sends nothing until you call something on it.
from pathlib import Path

from caitlyn import (
    AgentAvatarInput,
    AgentMarkInput,
    AvatarColour,
    Caitlyn,
    CreateUploadResult,
    CreatedAgentScope,
    EstimateIngestionResult,
    Document,
    IngestionBatch,
    IngestionBatchItem,
    KnowledgeBaseScope,
    SyncPlan,
    SyncReport,
    UploadFile,
)


def add_document(kb: KnowledgeBaseScope) -> Document:
    # #region add-document
    # The SDK hashes the file, uploads it and creates the document; .wait() returns it once it can be searched.
    doc = kb.documents.create("leave-policy.pdf", folder="/hr/").wait()
    print(doc.id, doc.status)
    # #endregion
    return doc


def sync_folder(kb: KnowledgeBaseScope) -> SyncReport[IngestionBatch, IngestionBatchItem]:
    # #region sync-folder
    # Keeps /policies/ in step with a local folder: new files are added, changed ones get a new version and, with
    # remove_missing, documents whose file is gone are removed. Files are keyed by their path in the folder.
    report = kb.ingestion.sync("./policies", folder="/policies/", remove_missing=True)
    for item in report.items:
        print(item.path, item.outcome, item.status, item.failure_code or "")
    # #endregion
    return report


def sync_estimate(kb: KnowledgeBaseScope) -> SyncPlan[IngestionBatch, IngestionBatchItem, EstimateIngestionResult]:
    # #region sync-estimate
    # What the same sync would do and cost, before anything is uploaded.
    plan = kb.ingestion.sync.estimate("./policies", folder="/policies/", remove_missing=True)
    if plan.estimate is not None:
        print(plan.estimate.documents, "documents,", plan.estimate.duration_seconds.high, "seconds at most")
        if plan.estimate.cost:  # only for callers allowed to see cost
            print(plan.estimate.cost.low, "to", plan.estimate.cost.high, plan.estimate.cost.unit)
    # #endregion
    return plan


def replace_document(kb: KnowledgeBaseScope, document_id: str) -> Document:
    # #region replace-document
    # A new version of the same document. The current version keeps answering until the new one is indexed.
    doc = kb.documents(document_id).replace("leave-policy-2027.pdf").wait()
    print(doc.version, doc.status)
    # #endregion
    return doc


def watch_document(kb: KnowledgeBaseScope, document_id: str) -> Document:
    # #region watch-document
    # After a page reload, from the document's identifier alone: its progress as it stands, then each change, until it
    # can be searched. The percentage never goes backwards, and reaches 100 only once the document can be searched.
    doc = kb.documents(document_id).wait(on_progress=lambda p: print(p.stage, f"{p.percent}%", p.eta))
    # #endregion
    return doc


def set_access(kb: KnowledgeBaseScope, document_id: str) -> None:
    # #region set-access
    # Only the HR team may read what is in /hr/investigations/; the document follows its folder again.
    kb.folders("/hr/investigations/").access.set(readers={"roles": ["hr-team"]})
    kb.documents(document_id).access.set(readers="inherit")
    # #endregion


def set_access_guarded(kb: KnowledgeBaseScope) -> None:
    # #region set-access-guarded
    # A guarded write: with the access's ETag, a change someone made since you read it is refused with 412.
    folder = kb.folders("/hr/investigations/")
    folder.access.set(readers={"roles": ["hr-team"]}, if_match=folder.access.get().etag)
    # #endregion


def publish_agent(caitlyn: Caitlyn, instructions: str) -> CreatedAgentScope:
    # #region publish-agent
    agent = caitlyn.agents.create(name="HR assistant", configuration={"guidance": {"instructions": instructions}})
    agent.draft.publish(name="v1")
    # #endregion
    return agent


def roll_back(caitlyn: Caitlyn, agent_id: str) -> None:
    # #region roll-back
    # Live points at v13 again. v13 itself is unchanged, and the agent's history records the move as a rollback.
    caitlyn.agents(agent_id).versions("v13").publish()
    # #endregion


def chat(caitlyn: Caitlyn, agent_id: str) -> str:
    # #region chat
    conversation = caitlyn.agents(agent_id).live.conversations.create()
    for text in conversation.send("How much leave do part-time staff get?").text():
        print(text, end="")
    # #endregion
    return conversation.id


def watch_conversation(caitlyn: Caitlyn, conversation_id: str) -> None:
    # #region watch-conversation
    # After a page reload, with only the conversation's ID: the answer being written, from its start, then every
    # answer after it.
    with caitlyn.conversations(conversation_id).watch() as events:
        for event in events:
            if event.type == "text.delta":
                print(event.delta, end="")
            elif event.type in ("message.completed", "message.failed"):
                break
    # #endregion


def watch_knowledge_base(kb: KnowledgeBaseScope) -> None:
    # #region watch-knowledge-base
    with kb.watch() as events:
        for event in events:
            if event.type == "snapshot":
                print(event.knowledge_base, [(job.kind, job.status) for job in event.jobs])
            else:
                print(event.type)  # document.updated, document.progress, job.progress, …
    # #endregion


def delete_things(caitlyn: Caitlyn, kb: KnowledgeBaseScope, document_id: str, agent_id: str) -> None:
    # #region delete-things
    kb.documents(document_id).delete()
    kb.folders("/archive/").delete().wait()
    kb.delete().wait()
    caitlyn.agents(agent_id).delete()
    # #endregion


def fill_in_fields(kb: KnowledgeBaseScope) -> None:
    # #region fill-in-fields
    estimate = kb.fields.fill_in.estimate(["policyOwner"])
    if estimate.cost:
        print(f"{estimate.documents} documents, {estimate.cost.low}–{estimate.cost.high} {estimate.cost.unit}")
    kb.fields.fill_in(["policyOwner"]).wait()
    # #endregion


def reprocess(kb: KnowledgeBaseScope) -> None:
    # #region reprocess
    # Processes the documents that are out of date again, the newest way; the estimate takes the same arguments.
    print(kb.documents.reprocess.estimate(out_of_date=True).documents)
    kb.documents.reprocess(out_of_date=True).wait()
    # #endregion


def layout_aware_search(kb: KnowledgeBaseScope) -> None:
    # #region layout-aware-search
    print(kb.layout_aware_search.enable.estimate().duration_seconds.high)
    kb.layout_aware_search.enable().wait()
    # #endregion


def avatar_picture(caitlyn: Caitlyn, picture: Path) -> CreatedAgentScope:
    # #region avatar-picture
    # The avatar's picture is a file: the SDK uploads it (a PNG, JPEG or WebP of at most 1 MB) and sends the
    # upload's id in its place.
    agent = caitlyn.agents.create(
        name="HR assistant",
        avatar=AgentAvatarInput(colour=AvatarColour("sage"), mark=AgentMarkInput(picture_upload_id=UploadFile.from_path(picture))),
    )
    # #endregion
    return agent


def send_upload(caitlyn: Caitlyn, path: Path) -> CreateUploadResult:
    # #region send-upload
    # The building block under every call that takes a file: hashes it, reserves an upload, and sends the bytes.
    # Most code never needs it; an upload's id is accepted where a call takes a file (upload_id=…).
    upload = caitlyn.core.uploads.send(path)
    print(upload.id, upload.status)
    # #endregion
    return upload
