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
//! The agent checks leave the agent as they found it: they save the draft as a version, change it, reset it from that
//! version, then delete it. The publish check, on the publish agent only, publishes its draft under a unique name,
//! checks publishedAt; live keeps what was published.
//! GetHistory reads that agent's history, since entries come only from publishing.
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use caitlyn_examples::conversations as operations;
use caitlyn_examples::documents;
use caitlyn_sdk::{Auth, Client, ConversationEvent, Error, WorkspaceEvent};

/// Diagnostics, not a check: prints each change in a document's status to standard error, read every 15 s until
/// the returned guard is dropped, so a delete that does not finish shows what the document did instead.
fn log_status_changes(client: &Client, kb: &str, id: &str) -> AbortOnDrop {
    let (client, kb, id) = (client.clone(), kb.to_owned(), id.to_owned());
    AbortOnDrop(tokio::spawn(async move {
        let started = std::time::Instant::now();
        let mut last = String::new();
        loop {
            let now = match client.knowledge_base(&kb).document(&id).get().await {
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

async fn check_within(
    name: &str,
    limit: Duration,
    failed: &mut bool,
    f: impl Future<Output = Check>,
) {
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
    static OUT: std::sync::OnceLock<Option<std::sync::Mutex<std::fs::File>>> =
        std::sync::OnceLock::new();
    let out = OUT.get_or_init(|| {
        let fd: std::os::fd::RawFd = std::env::var("CAITLYN_EXAMPLES_CHECK_FD")
            .ok()?
            .parse()
            .ok()?;
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
    h.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    h.finish() as u32
}

fn s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A UUIDv7 for a moment `age` ago: a cursor the server can no longer carry on from.
fn uuid_v7_from(age: Duration) -> String {
    let ms = (SystemTime::now() - age)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let hex = format!(
        "{:012x}7{:03x}{:x}{:015x}",
        ms & 0xffff_ffff_ffff,
        0x123,
        0x8,
        0x456_789a_bcde_f012_u64
    );
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[tokio::main]
async fn main() {
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("examples_live: set {k}"));
    let (workspace, agent_id) = (env("CAITLYN_WORKSPACE"), env("CAITLYN_AGENT_ID"));
    let client = Client::builder(&workspace, Auth::token(env("CAITLYN_TOKEN")))
        .endpoint(env("CAITLYN_ENDPOINT"))
        .build()
        .expect("client");
    let run = format!("{:08x}", random_u32());
    let mut failed = false;

    check("GetCaller", &mut failed, async {
        let caller = operations::get_caller(&client).await.map_err(s)?;
        (!caller.display_name.is_empty())
            .then_some(())
            .ok_or_else(|| "no display name".into())
    })
    .await;

    check("GetAgentVersion", &mut failed, async {
        let draft = client.agent(&agent_id).draft().get().await.map_err(why)?;
        (draft.agent_id == agent_id)
            .then_some(())
            .ok_or_else(|| format!("agent {}", draft.agent_id).into())
    })
    .await;

    check("WatchWorkspaceEvents", &mut failed, async {
        let seen = operations::watch_workspace_events(&client, &agent_id)
            .await
            .map_err(why)?;
        seen.map(|_| ())
            .ok_or_else(|| "no conversation.created".into())
    })
    .await;

    let conversation = client
        .agent(&agent_id)
        .draft()
        .conversations()
        .create()
        .title(format!("examples {run}"))
        .await;
    check("CreateConversation", &mut failed, async {
        let c = conversation.as_ref().map_err(|e| e.to_string())?;
        (!c.id().is_empty())
            .then_some(())
            .ok_or_else(|| "no id".into())
    })
    .await;
    if let Ok(conversation) = &conversation {
        check("SendMessage", &mut failed, async {
            let mut answer = conversation
                .send("In one sentence, what can you help me with?")
                .await
                .map_err(why)?;
            let message = answer.final_message().await.map_err(why)?;
            (!message.text.is_empty())
                .then_some(())
                .ok_or_else(|| "an empty answer".into())
        })
        .await;
        check("WatchConversation", &mut failed, async {
            let watch = client.conversation(conversation.id()).watch();
            let send = conversation.send("And in one word?");
            let mut stream = watch.await.map_err(why)?;
            drop(send.await.map_err(why)?);
            while let Some(event) = stream.next().await {
                if let ConversationEvent::MessageCompleted(_) = event.map_err(why)? {
                    return Ok(());
                }
            }
            Err("the watch ended before the answer".into())
        })
        .await;
    }

    check("stream.reset", &mut failed, async {
        let cursor = uuid_v7_from(Duration::from_secs(2 * 24 * 3600));
        match operations::resume_workspace_events(&client, &cursor)
            .await
            .map_err(why)?
        {
            Some(WorkspaceEvent::StreamReset(_)) => Ok(()),
            other => Err(format!("first event {other:?}").into()),
        }
    })
    .await;

    let upload = documents::send_upload(&client, &fixture()).await;
    check("CreateUpload", &mut failed, async {
        upload
            .as_ref()
            .map(|_| ())
            .map_err(|e| e.to_string().into())
    })
    .await;
    if let Ok(upload) = &upload {
        check("GetUpload", &mut failed, async {
            let got = client.core().upload(&upload.id).get().await.map_err(why)?;
            (got.id == upload.id)
                .then_some(())
                .ok_or_else(|| "another upload".into())
        })
        .await;
    }

    match std::env::var("CAITLYN_KNOWLEDGE_BASE_ID") {
        Err(_) => {
            for name in [
                "CreateDocument",
                "DeleteDocument.processing",
                "GetDocument",
                "Document.wait",
                "ListDocuments",
                "DeleteDocument",
                "BatchDeleteDocuments",
                "DeleteDocument.wait",
            ] {
                check(name, &mut failed, async {
                    Err(Why::Skip("no knowledge base configured".into()))
                })
                .await;
            }
        }
        Ok(kb_id) => {
            let kb = client.knowledge_base(&kb_id);
            let path = run_copy(&format!("leave-policy-{run}.pdf"));
            let created = match &path {
                Ok(p) => kb
                    .documents()
                    .create(p)
                    .folder("/examples/")
                    .await
                    .map_err(why),
                Err(e) => Err(Why::Fail(e.to_string())),
            };
            check("CreateDocument", &mut failed, async {
                created.as_ref().map(|_| ()).map_err(|w| {
                    Why::Fail(match w {
                        Why::Fail(s) | Why::Skip(s) => s.clone(),
                    })
                })
            })
            .await;
            if let Ok(doc) = &created {
                let _log = log_status_changes(&client, &kb_id, doc.id());
                check("DeleteDocument.processing", &mut failed, async {
                    // A document still being processed can be deleted: its processing stops, and it never comes back.
                    let path = run_copy(&format!("leave-policy-{run}-gone.pdf")).map_err(s)?;
                    let busy = kb
                        .documents()
                        .create(&path)
                        .folder("/examples/")
                        .await
                        .map_err(why)?;
                    busy.delete().wait().await.map_err(why)?;
                    match busy.get().await {
                        Err(Error::NotFound(_)) => {}
                        other => return Err(format!("after the delete: {other:?}").into()),
                    }
                    let listed = kb
                        .documents()
                        .list()
                        .folder("/examples/")
                        .collect()
                        .await
                        .map_err(why)?;
                    (!listed.iter().any(|d| d.id == busy.id()))
                        .then_some(())
                        .ok_or_else(|| "the deleted document is listed again".into())
                })
                .await;
                check("GetDocument", &mut failed, async {
                    let got = doc.get().await.map_err(why)?;
                    (got.id == doc.id())
                        .then_some(())
                        .ok_or_else(|| "another document".into())
                })
                .await;
                check("Document.wait", &mut failed, async {
                    let indexed = doc.wait().await.map_err(why)?;
                    matches!(indexed.status.as_str(), "indexed" | "partially_indexed")
                        .then_some(())
                        .ok_or_else(|| format!("status {}", indexed.status).into())
                })
                .await;
                check("ListDocuments", &mut failed, async {
                    documents::list_documents(&client, &kb_id)
                        .await
                        .map(|_| ())
                        .map_err(why)
                })
                .await;
                check("DeleteDocument", &mut failed, async {
                    doc.delete().await.map(|_| ()).map_err(why)
                })
                .await;
                check("DeleteDocument.wait", &mut failed, async {
                    doc.delete()
                        .send()
                        .await
                        .map_err(why)?
                        .wait()
                        .await
                        .map_err(why)
                })
                .await;
            }
            check("BatchDeleteDocuments", &mut failed, async {
                kb.documents()
                    .delete_many([format!("missing-{run}")])
                    .await
                    .map(|_| ())
                    .map_err(why)
            })
            .await;
        }
    }

    let agent = client.agent(&agent_id);
    let saved_name = format!("examples-{run}");
    let saved = agent.draft().save(&saved_name).note("examples_live").await;
    check("SaveDraftVersion", &mut failed, async {
        saved.as_ref().map(|_| ()).map_err(|e| e.to_string().into())
    })
    .await;
    check("ListAgentVersions", &mut failed, async {
        let versions = agent.versions().list().collect().await.map_err(why)?;
        versions
            .iter()
            .any(|v| v.name == saved_name)
            .then_some(())
            .ok_or_else(|| "the saved version is not listed".into())
    })
    .await;
    check("UpdateDraftVersion", &mut failed, async {
        agent
            .draft()
            .update()
            .guidance(caitlyn_sdk::AgentGuidance {
                instructions: Some(format!("Changed by examples_live {run}")),
                ..Default::default()
            })
            .await
            .map(|_| ())
            .map_err(why)
    })
    .await;
    check("ResetDraftVersion", &mut failed, async {
        let draft = agent.draft().get().await.map_err(why)?;
        agent
            .draft()
            .reset(&saved_name)
            .if_match(&draft.etag)
            .await
            .map(|_| ())
            .map_err(why)
    })
    .await;
    match std::env::var("CAITLYN_PUBLISH_AGENT_ID") {
        Err(_) => {
            for name in [
                "PublishAgentVersion",
                "ListHistoryEntries",
                "GetHistoryEntry",
            ] {
                check(name, &mut failed, async {
                    Err(Why::Skip("publishing turned off".into()))
                })
                .await;
            }
        }
        Ok(publish_id) => {
            let publisher = client.agent(&publish_id);
            check("PublishAgentVersion", &mut failed, async {
                let published = publisher
                    .draft()
                    .publish()
                    .name(format!("examples-{run}"))
                    .await
                    .map_err(why)?;
                (published.live.version == format!("examples-{run}"))
                    .then_some(())
                    .ok_or_else(|| format!("live is {}", published.live.version).into())
            })
            .await;
            let history = publisher.history().list().collect().await;
            check("ListHistoryEntries", &mut failed, async {
                history
                    .as_ref()
                    .map(|_| ())
                    .map_err(|e| e.to_string().into())
            })
            .await;
            check("GetHistoryEntry", &mut failed, async {
                let first = history
                    .as_ref()
                    .map_err(|e| e.to_string())?
                    .first()
                    .ok_or("no history")?
                    .id
                    .clone();
                publisher
                    .history_entry(&first)
                    .get()
                    .await
                    .map(|_| ())
                    .map_err(why)
            })
            .await;
        }
    }
    check("DeleteAgentVersion", &mut failed, async {
        agent
            .version(&saved_name)
            .delete()
            .await
            .map(|_| ())
            .map_err(why)
    })
    .await;

    std::process::exit(i32::from(failed));
}
