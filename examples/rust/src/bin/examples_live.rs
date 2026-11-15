//! Runs the developer docs' examples (src/conversations.rs, src/documents.rs, src/agents.rs) against a real Caitlyn
//! workspace and prints one line per check: `ok <check>`, `fail <check>: <why>`, or `skip <check>: <why>` for a
//! check this workspace cannot run. scripts/examples-live/rust.sh runs it for scripts/examples-live.mjs, which sets:
//!
//!   CAITLYN_ENDPOINT           the API address requests go to (the client's endpoint)
//!   CAITLYN_WORKSPACE          the workspace hostname
//!   CAITLYN_TOKEN              a personal access token for a person in that workspace
//!   CAITLYN_AGENT_ID           an agent whose draft can answer
//!   CAITLYN_KNOWLEDGE_BASE_ID  optional: a knowledge base the document checks may add a document to
//!   CAITLYN_PUBLISH_AGENT_ID   optional: an agent the publish check may publish
//!
//! A skip gives one of the runner's named reasons: `no knowledge base configured` or `publishing turned off`.
//! The agent checks leave the agent as they found it: they pin the draft, change it, reset it from the pin, then
//! delete the pin. The publish check, on the publish agent only, pins its draft under a unique name, publishes it
//! with production's ETag, checks publishedAt, then deletes the pinned version; production keeps what was published.
//! GetProductionHistory reads that agent's history, since entries come only from publishing.
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use caitlyn_examples::conversations as operations;
use caitlyn_examples::{agents, documents};
use caitlyn_sdk::{Auth, Client, ConversationEvent, DeleteDocumentInput, Error, GetDocumentInput, WorkspaceEvent};

/// Diagnostics, not a check: prints each change in a document's status to standard error, read every 15 s until
/// the returned guard is dropped, so a delete that does not finish shows what the document did instead.
fn log_status_changes(client: &Client, kb: &str, id: &str) -> AbortOnDrop {
    let (client, kb, id) = (client.clone(), kb.to_owned(), id.to_owned());
    AbortOnDrop(tokio::spawn(async move {
        let started = std::time::Instant::now();
        let mut last = String::new();
        loop {
            let input = GetDocumentInput {
                knowledge_base_id: kb.clone(),
                document_id: id.clone(),
            };
            let now = match client.documents().get(input).await {
                Ok(d) => [
                    Some(d.status.as_str().to_owned()),
                    d.stage,
                    d.failure.map(|f| f.code.as_str().to_owned()),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" "),
                Err(e) if e.status() == Some(404) => "404".to_owned(),
                Err(e) => format!("error {e}"),
            };
            if now != last {
                eprintln!("status: {id} at {} s: {now}", started.elapsed().as_secs());
                last = now;
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    }))
}

/// Stops a spawned task when dropped, including when a check's time limit cancels the check.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Why a check did not pass: it failed, or it cannot run against this workspace.
enum Why {
    Fail(String),
    Skip(String),
}

impl From<String> for Why {
    fn from(s: String) -> Self {
        Why::Fail(s)
    }
}

impl From<&str> for Why {
    fn from(s: &str) -> Self {
        Why::Fail(s.to_owned())
    }
}

type Check = Result<(), Why>;

/// A call's error, as a failure. A 403 reads `403 PERMISSION_DENIED: <detail>`: the shared runner, not this program,
/// decides whether that is the `public role only` skip (CAITLYN_PUBLIC_ROLE_ONLY=1).
fn why(e: Error) -> Why {
    match e {
        Error::PermissionDenied(p) => Why::Fail(format!(
            "403 PERMISSION_DENIED: {}",
            p.detail.as_deref().or(p.title.as_deref()).unwrap_or("")
        )),
        e => Why::Fail(e.to_string()),
    }
}

/// Prints the check's line, with a time limit so a stream that never ends fails instead of hanging.
async fn check(name: &str, failed: &mut bool, f: impl Future<Output = Check>) {
    check_within(name, Duration::from_secs(180), failed, f).await
}

async fn check_within(name: &str, limit: Duration, failed: &mut bool, f: impl Future<Output = Check>) {
    let r = tokio::time::timeout(limit, f)
        .await
        .unwrap_or_else(|_| Err(format!("no result after {} s", limit.as_secs()).into()));
    let line = match r {
        Ok(()) => format!("ok {name}"),
        Err(Why::Skip(why)) => format!("skip {name}: {}", why.replace('\n', " ")),
        Err(Why::Fail(why)) => {
            *failed = true;
            format!("fail {name}: {}", why.replace('\n', " "))
        }
    };
    report(&line);
}

/// Writes a check's line to standard output, or to the file descriptor CAITLYN_EXAMPLES_CHECK_FD names:
/// scripts/examples-live/rust.sh opens descriptor 3 on its standard output and sends the program's own standard
/// output, which carries what the examples print, to standard error.
fn report(line: &str) {
    use std::io::Write;
    static OUT: std::sync::OnceLock<Option<std::sync::Mutex<std::fs::File>>> = std::sync::OnceLock::new();
    let out = OUT.get_or_init(|| {
        let fd: std::os::fd::RawFd = std::env::var("CAITLYN_EXAMPLES_CHECK_FD").ok()?.parse().ok()?;
        // SAFETY: the runner opened this descriptor for the program (`3>&1` in rust.sh) and nothing else uses it.
        // The descriptor is written to as is, never reopened by path: a socket, which Node's child-process
        // pipes are, cannot be reopened through /dev/fd.
        Some(std::sync::Mutex::new(unsafe {
            <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fd)
        }))
    });
    match out {
        Some(f) => {
            let mut f = f.lock().unwrap_or_else(|e| e.into_inner());
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
        None => println!("{line}"),
    }
}

/// A failure from an example that also reads a file: the SDK's error as `why` reports it, or the I/O error.
fn boxed(e: Box<dyn std::error::Error + Send + Sync>) -> Why {
    match e.downcast::<Error>() {
        Ok(e) => why(*e),
        Err(e) => Why::Fail(e.to_string()),
    }
}

/// The one-page leave policy every language's live checks upload (examples/fixtures/leave-policy.pdf).
fn fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/leave-policy.pdf")
}

/// A copy of the fixture under `name` in the temporary directory, so the upload takes that name.
fn run_copy(name: &str) -> std::io::Result<std::path::PathBuf> {
    let path = std::env::temp_dir().join(name);
    std::fs::copy(fixture(), &path)?;
    Ok(path)
}

/// A random number for the run id, from the standard library's randomly keyed hasher.
fn random_u32() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    h.finish() as u32
}

fn s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A UUIDv7 for a moment `age` ago: a cursor the server can no longer carry on from.
fn uuid_v7_from(age: Duration) -> String {
    let ms = (SystemTime::now() - age).duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let hex = format!(
        "{:012x}7{:03x}{:x}{:015x}",
        ms & 0xffff_ffff_ffff,
        0x123,
        0x8,
        0x456_789a_bcde_f012_u64
    );
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[tokio::main]
async fn main() {
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("examples_live: set {k}"));
    let (workspace, agent_id) = (env("CAITLYN_WORKSPACE"), env("CAITLYN_AGENT_ID"));
    let client = Client::builder(&workspace, Auth::token(env("CAITLYN_TOKEN")))
        .endpoint(env("CAITLYN_ENDPOINT"))
        .build()
        .expect("client");
    let mut failed = false;

    check("GetCaller", &mut failed, async {
        let caller = operations::get_caller(&client).await.map_err(s)?;
        (!caller.display_name.is_empty())
            .then_some(())
            .ok_or_else(|| "no display name".into())
    })
    .await;

    check("GetAgentVersion", &mut failed, async {
        let draft = operations::get_agent_version(&client, &agent_id).await.map_err(s)?;
        (draft.agent_id == agent_id)
            .then_some(())
            .ok_or_else(|| format!("agent {}", draft.agent_id).into())
    })
    .await;

    check("WatchWorkspaceEvents", &mut failed, async {
        let created = operations::watch_workspace_events(&client, &agent_id).await.map_err(s)?;
        let created = created.ok_or("the stream ended before conversation.created")?;
        created.event_id.is_some().then_some(()).ok_or_else(|| "the event has no id".into())
    })
    .await;

    let mut conversation_id = None;
    check("CreateConversation", &mut failed, async {
        let c = operations::create_conversation(&client, &agent_id).await.map_err(s)?;
        conversation_id = Some(c.id.clone());
        (c.agent_id == agent_id && c.version == "draft")
            .then_some(())
            .ok_or_else(|| format!("{c:?}").into())
    })
    .await;

    // The answer is watched while it is written. The watch opens first: it streams the answer being written, if
    // there is one, then every answer after it, and it does not end by itself, so it stops at message.completed.
    let (sent, watched): (Result<_, String>, Result<_, String>) = match conversation_id.as_deref() {
        Some(id) => {
            let (watched, sent) = tokio::join!(operations::watch_conversation(&client, id), async {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                operations::send_message(&client, id).await
            });
            (sent.map_err(s), watched.map_err(s))
        }
        None => (Err("no conversation was created".into()), Err("no conversation was created".into())),
    };
    let answer_id = sent.as_ref().ok().map(|m| m.id.clone());
    check("SendMessage", &mut failed, async {
        let m = sent?;
        (!m.text.is_empty()).then_some(()).ok_or_else(|| "the answer has no text".into())
    })
    .await;
    check("WatchConversation", &mut failed, async {
        match watched? {
            Some(ConversationEvent::MessageCompleted(done)) => match &answer_id {
                Some(id) if &done.message.id != id => Err(format!("completed {} but sent {id}", done.message.id).into()),
                _ => Ok(()),
            },
            Some(ConversationEvent::MessageFailed(f)) => {
                Err(format!("message.failed {} {} (request {})", f.code, f.title, f.request_id).into())
            }
            _ => Err("the stream ended before message.completed".into()),
        }
    })
    .await;

    check("stream.reset", &mut failed, async {
        let cursor = uuid_v7_from(Duration::from_secs(2 * 24 * 60 * 60));
        let first = operations::resume_workspace_events(&client, &cursor).await.map_err(s)?;
        match &first {
            Some(WorkspaceEvent::StreamReset(reset)) if Some(reset.cursor.as_str()) == first.as_ref().and_then(|e| e.event_id()) => Ok(()),
            Some(WorkspaceEvent::StreamReset(reset)) => Err(format!("cursor {} but event id {:?}", reset.cursor, reset.event_id).into()),
            other => Err(format!("first event {other:?}").into()),
        }
    })
    .await;

    // Uploads and documents. The document checks add a document, so they run only with a knowledge base set aside
    // for them.
    // Makes the names and identifiers this run creates unique: the time and a random part.
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let run_id = format!("{stamp}-{:08x}", random_u32());
    // The run's documents are told apart by name: the fixture, copied under a name of the run's own.
    let first_pdf = run_copy(&format!("leave-policy-{run_id}.pdf"));
    let second_pdf = run_copy(&format!("leave-policy-{run_id}-2.pdf"));
    let third_pdf = run_copy(&format!("leave-policy-{run_id}-3.pdf"));
    let mut upload_id = None;
    check("CreateUpload", &mut failed, async {
        let upload = documents::create_upload(&client, first_pdf.as_ref().map_err(s)?)
            .await
            .map_err(boxed)?;
        upload_id = Some(upload.id.clone());
        (!upload.id.is_empty()).then_some(()).ok_or_else(|| "no upload id".into())
    })
    .await;
    check("GetUpload", &mut failed, async {
        let id = upload_id.as_deref().ok_or("no upload was created")?;
        let upload = documents::get_upload(&client, id).await.map_err(why)?;
        (upload.id == id && upload.status.as_str() == "received")
            .then_some(())
            .ok_or_else(|| format!("upload {} is {}", upload.id, upload.status.as_str()).into())
    })
    .await;
    match std::env::var("CAITLYN_KNOWLEDGE_BASE_ID").ok().filter(|k| !k.is_empty()) {
        None => {
            for name in [
                "CreateDocument",
                "GetDocument",
                "WaitUntilIndexed",
                "ListDocuments",
                "DeleteDocument",
                "BatchDeleteDocuments",
                "WaitUntilDeleted",
            ] {
                check(name, &mut failed, async {
                    Err(Why::Skip("no knowledge base configured (CAITLYN_KNOWLEDGE_BASE_ID)".into()))
                })
                .await;
            }
        }
        Some(kb) => {
            let mut document_id = None;
            check("CreateDocument", &mut failed, async {
                let id = upload_id.as_deref().ok_or("no upload was created")?;
                let created = documents::create_document(&client, &kb, id).await.map_err(why)?;
                document_id = Some(created.document.id.clone());
                Ok(())
            })
            .await;
            // A document still being processed cannot be deleted yet: 409 CONFLICT. A third document is deleted the
            // moment it is created, while it is pending. A one-page PDF can index quickly, so if it has already
            // finished processing, the delete is accepted instead; that passes too, and says so on standard error.
            // The clean-up deletes it once it is indexed.
            let mut third_id = None;
            check("DeleteDocument.processing", &mut failed, async {
                let upload = documents::create_upload(&client, third_pdf.as_ref().map_err(s)?)
                    .await
                    .map_err(boxed)?;
                let third = documents::create_document(&client, &kb, &upload.id).await.map_err(why)?.document.id;
                third_id = Some(third.clone());
                let input = DeleteDocumentInput {
                    knowledge_base_id: kb.clone(),
                    document_id: third.clone(),
                };
                match client.documents().delete(input).await {
                    Err(Error::Conflict(e)) if e.code == "CONFLICT" => Ok(()),
                    Err(Error::Conflict(e)) => Err(format!("409 with code {}", e.code).into()),
                    Err(e) => Err(why(e)),
                    Ok(d) if d.status.as_str() == "deleting" => {
                        eprintln!("DeleteDocument.processing: {third} had already finished processing; the delete was accepted");
                        Ok(())
                    }
                    Ok(d) => Err(format!("the delete was neither refused nor accepted: {}", d.status.as_str()).into()),
                }
            })
            .await;
            check("GetDocument", &mut failed, async {
                let id = document_id.as_deref().ok_or("no document was created")?;
                let d = documents::get_document(&client, &kb, id).await.map_err(why)?;
                (d.id == id).then_some(()).ok_or_else(|| format!("got {}", d.id).into())
            })
            .await;
            check_within("WaitUntilIndexed", Duration::from_secs(16 * 60), &mut failed, async {
                let id = document_id.as_deref().ok_or("no document was created")?;
                let d = documents::wait_until_indexed(&client, &kb, id).await.map_err(why)?;
                matches!(d.status.as_str(), "indexed" | "partially_indexed")
                    .then_some(())
                    .ok_or_else(|| format!("status {}", d.status.as_str()).into())
            })
            .await;
            check("ListDocuments", &mut failed, async {
                let id = document_id.as_deref().ok_or("no document was created")?;
                // The run's document is listed in /policies/ whatever its status: indexing need not have finished.
                let found = documents::list_documents(&client, &kb).await.map_err(why)?;
                found
                    .iter()
                    .any(|d| d.id == id)
                    .then_some(())
                    .ok_or_else(|| format!("{id} is not in /policies/").into())
            })
            .await;

            // Every document the run creates is deleted. `left` holds those not yet known to be gone; whatever
            // fails, they are batch-deleted at the end and waited for.
            let mut left: Vec<String> = document_id.iter().chain(third_id.iter()).cloned().collect();
            check("DeleteDocument", &mut failed, async {
                let id = document_id.as_deref().ok_or("no document was created")?;
                let d = documents::delete_document(&client, &kb, id).await.map_err(why)?;
                (d.status.as_str() == "deleting")
                    .then_some(())
                    .ok_or_else(|| format!("{id} is {}", d.status.as_str()).into())
            })
            .await;
            check_within("WaitUntilDeleted", Duration::from_secs(16 * 60), &mut failed, async {
                let id = document_id.as_deref().ok_or("no document was created")?;
                documents::wait_until_deleted(&client, &kb, id).await.map_err(why)?;
                left.retain(|d| d != id);
                Ok(())
            })
            .await;
            check_within("BatchDeleteDocuments", Duration::from_secs(16 * 60), &mut failed, async {
                // A second document from the same PDF, under the run's second name.
                let upload = documents::create_upload(&client, second_pdf.as_ref().map_err(s)?)
                    .await
                    .map_err(boxed)?;
                let second = documents::create_document(&client, &kb, &upload.id).await.map_err(why)?.document.id;
                left.push(second.clone());
                // Only a document that has finished processing can be deleted
                documents::wait_until_indexed(&client, &kb, &second).await.map_err(why)?;
                let missing = format!("doc-sdk-check-missing-{stamp}");
                let _status_log = log_status_changes(&client, &kb, &second);
                let r = documents::batch_delete_documents(&client, &kb, &[second.clone(), missing.clone()])
                    .await
                    .map_err(why)?;
                let got: Vec<(String, String, Option<String>)> = r
                    .results
                    .iter()
                    .map(|e| (e.document_id.clone(), e.status.as_str().to_owned(), e.code.clone()))
                    .collect();
                let want = [
                    (second.clone(), "accepted".to_owned(), None),
                    (missing.clone(), "failed".to_owned(), Some("NOT_FOUND".to_owned())),
                ];
                if got.len() != 2 || got[0].0 != want[0].0 || got[0].1 != want[0].1 || got[1] != want[1] {
                    return Err(format!("results {got:?}").into());
                }
                documents::wait_until_deleted(&client, &kb, &second).await.map_err(why)?;
                left.retain(|d| d != &second);
                Ok(())
            })
            .await;
            if !left.is_empty() {
                // Clean-up of DeleteDocument.processing's document, and of whatever a failed check left: not a check, so
                // it reports only to standard error. Only a document that has finished processing can be deleted, so
                // each is waited for first; a failed or deleting one ends the wait, which is all that is wanted.
                for id in &left {
                    let _ = documents::wait_until_indexed(&client, &kb, id).await;
                }
                match documents::batch_delete_documents(&client, &kb, &left).await {
                    Ok(_) => {
                        for id in &left {
                            if let Err(e) = documents::wait_until_deleted(&client, &kb, id).await {
                                eprintln!("examples_live: {id} may not be deleted: {e}");
                            }
                        }
                    }
                    Err(e) => eprintln!("examples_live: could not delete {left:?}: {e}"),
                }
            }
        }
    }

    // Agent versions, leaving the agent as it was found.
    let pin_name = format!("sdk-check-rust-{stamp}");
    let original = operations::get_agent_version(&client, &agent_id).await;
    let mut pinned = false;
    check("PinDraftVersion", &mut failed, async {
        let draft = original.as_ref().map_err(s)?;
        let pin = agents::pin_draft(&client, &agent_id, &draft.etag, &pin_name).await.map_err(why)?;
        pinned = true;
        (pin.name == pin_name)
            .then_some(())
            .ok_or_else(|| format!("pinned as {}", pin.name).into())
    })
    .await;
    check("ListAgentVersions", &mut failed, async {
        let versions = agents::list_versions(&client, &agent_id).await.map_err(why)?;
        // Only named versions are listed; the draft and production are not entries.
        let names: Vec<&str> = versions.iter().map(|v| v.name.as_str()).collect();
        if !pinned {
            return Err("no pinned version to list".into());
        }
        names
            .contains(&pin_name.as_str())
            .then_some(())
            .ok_or_else(|| format!("{pin_name} is not in {names:?}").into())
    })
    .await;
    let marker = "\n\n(This line was added by the Rust SDK's checks and is removed again.)";
    let mut changed: Option<String> = None; // the draft's ETag after the change, while the draft differs from the original
    check("UpdateDraftVersion", &mut failed, async {
        let draft = original.as_ref().map_err(s)?;
        let text = format!("{}{marker}", draft.configuration.instructions);
        let updated = agents::update_draft(&client, &agent_id, &text).await.map_err(why)?;
        changed = Some(updated.etag.clone());
        (updated.configuration.instructions == text)
            .then_some(())
            .ok_or_else(|| "the instructions did not change".into())
    })
    .await;
    check("ResetDraftVersion", &mut failed, async {
        if !pinned {
            return Err("no pinned version to reset the draft from".into());
        }
        let draft = original.as_ref().map_err(s)?;
        let etag = match &changed {
            Some(e) => e.clone(),
            None => draft.etag.clone(),
        };
        let reset = agents::reset_draft(&client, &agent_id, &etag, &pin_name).await.map_err(why)?;
        changed = None;
        (reset.configuration.instructions == draft.configuration.instructions)
            .then_some(())
            .ok_or_else(|| "the draft's instructions are not the pinned version's".into())
    })
    .await;
    if let (Some(_), Ok(draft)) = (&changed, &original) {
        // The reset did not run: put the original instructions back.
        let _ = agents::update_draft(&client, &agent_id, &draft.configuration.instructions).await;
    }
    check("PublishAgentVersion", &mut failed, async {
        let publish_agent = std::env::var("CAITLYN_PUBLISH_AGENT_ID").ok().filter(|a| !a.is_empty());
        let agent = publish_agent
            .as_deref()
            .ok_or_else(|| Why::Skip("publishing turned off (CAITLYN_PUBLISH_AGENT_ID)".into()))?;
        let draft = client
            .agents()
            .versions()
            .get(caitlyn_sdk::GetAgentVersionInput {
                agent_id: agent.into(),
                version: "draft".into(),
            })
            .await
            .map_err(why)?;
        let name = format!("sdk-check-rust-publish-{stamp}");
        agents::pin_draft(&client, agent, &draft.etag, &name).await.map_err(why)?;
        let published = agents::publish_version(&client, agent, &name).await.map_err(why);
        // Production keeps what was published; the pinned version is no longer needed.
        let deleted = agents::delete_version(&client, agent, &name).await;
        let published = published?;
        deleted.map_err(|e| format!("published {name}, but could not delete it: {e}"))?;
        published
            .published_at
            .is_some()
            .then_some(())
            .ok_or_else(|| "production has no publishedAt".into())
    })
    .await;
    check("ListProductionHistory", &mut failed, async {
        agents::list_production_history(&client, &agent_id).await.map_err(why)?; // an empty history is a pass
        Ok(())
    })
    .await;
    // Entries come only from publishing, so the entry is read from the publish agent's history.
    check("GetProductionHistory", &mut failed, async {
        let publish_agent = std::env::var("CAITLYN_PUBLISH_AGENT_ID").ok().filter(|a| !a.is_empty());
        let agent = publish_agent
            .as_deref()
            .ok_or_else(|| Why::Skip("publishing turned off (CAITLYN_PUBLISH_AGENT_ID)".into()))?;
        let entries = agents::list_production_history(&client, agent).await.map_err(why)?;
        let id = entries
            .first()
            .map(|e| e.id.clone())
            .ok_or("the publish agent has no production history entry")?;
        let entry = agents::get_production_history(&client, agent, &id).await.map_err(why)?;
        (entry.id == id).then_some(()).ok_or_else(|| format!("got {}", entry.id).into())
    })
    .await;
    check("DeleteAgentVersion", &mut failed, async {
        if !pinned {
            return Err("no pinned version to delete".into());
        }
        agents::delete_version(&client, &agent_id, &pin_name).await.map_err(why)?;
        let versions = agents::list_versions(&client, &agent_id).await.map_err(why)?;
        (!versions.iter().any(|v| v.name == pin_name))
            .then_some(())
            .ok_or_else(|| format!("{pin_name} is still listed").into())
    })
    .await;

    for copy in [first_pdf, second_pdf, third_pdf].into_iter().flatten() {
        let _ = std::fs::remove_file(copy);
    }
    std::process::exit(i32::from(failed));
}
