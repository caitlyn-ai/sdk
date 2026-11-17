"""Static guarantees of the generated SDK, checked with pyright --strict on small snippets: `clear` only
accepts the clearable members, required members are not Optional, and stream events narrow by `type`."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]

PRELUDE = """
from caitlyn import Caitlyn
from caitlyn.auth import Token

c = Caitlyn(workspace="x", auth=Token("t"))
"""

CASES: dict[str, tuple[str, bool]] = {  # (code, is a type error)
    "clear accepts a clearable member": ('c.agents("a").draft.update(clear=["guidance.identity"])', False),
    "clear rejects other members": ('c.agents("a").draft.update(clear=["guidance"])', True),
    "required member is not Optional": ('n: int = len(c.agents("a").get().name)', False),
    "optional member is Optional": ('n: int = len(c.agents("a").get().description)', True),
    "a scope takes its identifier, not the call": ('c.knowledge_bases("k").documents("d").get(document_id="d")', True),
    "a named scope lacks what it leaves out": ('c.agents("a").live.publish()', True),
    "if_match is required where the model requires it": ('c.agents("a").update(name="n")', True),
    "if_match is optional where @ifMatchOptional": ('c.agents("a").draft.publish(name="v1")', False),
    "events narrow by type": (
        "with c.conversations('c').send('m') as s:\n"
        "    for e in s:\n"
        "        if e.type == 'text.delta':\n"
        "            d: str = e.delta",
        False,
    ),
    "a narrowed event has only its own members": (
        "with c.conversations('c').send('m') as s:\n"
        "    for e in s:\n"
        "        if e.type == 'phase.changed':\n"
        "            d: str = e.delta",
        True,
    ),
    "final message is typed": ("with c.conversations('c').send('m') as s:\n    t: str = s.final_message().text", False),
    "text() gives strings": ("for t in c.conversations('c').send('m').text():\n    n: int = len(t)", False),
    "a knowledge base's events narrow by type": (
        "with c.knowledge_bases('k').documents('d').watch() as s:\n"
        "    for e in s:\n"
        "        if e.type == 'document.progress':\n"
        "            p: int = e.processing.percent",
        False,
    ),
    "one processing accessor on every event": (
        "from caitlyn import DocumentProcessing, Job\n"
        "with c.knowledge_bases('k').documents('d').watch() as s:\n"
        "    for e in s:\n"
        "        p: DocumentProcessing | Job | None = e.processing",
        False,
    ),
    "on_progress gets a document's processing": (
        "c.knowledge_bases('k').documents('d').wait(on_progress=lambda p: print(p.stage, p.percent, p.eta))",
        False,
    ),
    "paginator yields typed items": ('for d in c.knowledge_bases("k").documents.list():\n    s: str = d.status', False),
    "field errors are typed": (
        "from caitlyn import ValidationError\n"
        "def f(err: ValidationError) -> None:\n"
        "    p: str | None = err.errors[0].pointer\n"
        "    k: str = err.errors[0].code",
        False,
    ),
    "a field error has only its own members": (
        "from caitlyn import ValidationError\n"
        "def f(err: ValidationError) -> None:\n"
        "    k: str = err.errors[0].pointer",
        True,
    ),
    "misspelt attribute is an error": ('c.agents("a").draft.get().configuration.guidence', True),
    "a document takes a file": ('c.knowledge_bases("k").documents.create("a.pdf", folder="/hr/")', False),
    "a document takes an upload already sent": ('c.knowledge_bases("k").documents.create(upload_id="u", folder="/hr/")', False),
    "a document needs a file or an upload": ('c.knowledge_bases("k").documents.create(folder="/hr/")', True),
    "create returns the new thing's scope": (
        'd = c.knowledge_bases("k").documents.create("a.pdf", folder="/hr/")\n'
        'i: str = d.id\n'
        's: str = d.document.status\n'
        'w: str = d.wait().status',
        False,
    ),
    "replace takes a file and waits": (
        'from caitlyn_core import UploadFile\n'
        'r = c.knowledge_bases("k").documents("d").replace(UploadFile.from_bytes(b"x", name="a.pdf"))\n'
        's: str = r.result.result\n'
        'n: int | None = r.wait().version',
        False,
    ),
    "an estimate takes the job's arguments": ('n: int = c.knowledge_bases("k").fields.fill_in.estimate(["policyOwner"]).documents', False),
    "an estimate of a job that takes a file takes the file": ('c.knowledge_bases("k").documents.create.estimate("a.pdf")', False),
    "readers shorthand": (
        'a = c.knowledge_bases("k").folders("/hr/").access\n'
        'a.set(readers="inherit", if_match="e")\n'
        'a.set(readers={"roles": ["hr-team"]}, if_match="e")',
        False,
    ),
    "readers shorthand refuses other words": ('c.knowledge_bases("k").folders("/hr/").access.set(readers="nobody", if_match="e")', True),
    "an avatar picture is a file or an upload's id": (
        'from caitlyn import AgentAvatarInput, AgentMarkInput\n'
        'from caitlyn_core import UploadFile\n'
        'c.agents.create(name="n", avatar=AgentAvatarInput(mark=AgentMarkInput(picture_upload_id=UploadFile.from_path("a.png"))))\n'
        'c.agents.create(name="n", avatar=AgentAvatarInput(mark=AgentMarkInput(picture_upload_id="up-1")))',
        False,
    ),
    "sync reports typed items": (
        'r = c.knowledge_bases("k").ingestion.sync("./policies")\n'
        'for i in r.items:\n'
        '    s: str = i.id',
        False,
    ),
    "sync.estimate gives the plan and its estimate": (
        'p = c.knowledge_bases("k").ingestion.sync.estimate("./policies")\n'
        'n: int = p.estimate.documents if p.estimate else 0',
        False,
    ),
    "the async client awaits the call, then the wait": (
        'from caitlyn import AsyncCaitlyn\n'
        'async def f(a: AsyncCaitlyn) -> str:\n'
        '    d = await (await a.knowledge_bases("k").documents.create("a.pdf", folder="/hr/")).wait()\n'
        '    return d.status',
        False,
    ),
}


@pytest.mark.parametrize("name", list(CASES))
def test_static(name: str, tmp_path: Path) -> None:
    code, expected = CASES[name]
    snippet = tmp_path / "snippet.py"
    snippet.write_text(PRELUDE + code + "\n")
    (tmp_path / "pyrightconfig.json").write_text(json.dumps({
        "typeCheckingMode": "strict",
        "pythonVersion": "3.12",
        "reportUnusedVariable": False,
        "reportUnusedExpression": False,
    }))
    out = subprocess.run(
        [sys.executable, "-m", "pyright", "--outputjson", "--pythonpath", sys.executable, "-p", str(tmp_path)],
        cwd=tmp_path, capture_output=True, text=True,
    )
    report = json.loads(out.stdout)
    errors = [d for d in report["generalDiagnostics"] if d["severity"] == "error"]
    assert bool(errors) == expected, "\n".join(d["message"] for d in errors) or "no type error"
