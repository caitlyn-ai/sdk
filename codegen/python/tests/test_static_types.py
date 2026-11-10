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
    "clear accepts a clearable member": ('c.versions.update_draft(agent_id="a", if_match="e", clear=["identity"])', False),
    "clear rejects other members": ('c.versions.update_draft(agent_id="a", if_match="e", clear=["instructions"])', True),
    "required member is not Optional": ('n: int = len(c.versions.get(agent_id="a", version="draft").configuration.instructions)', False),
    "optional member is Optional": ('n: int = len(c.versions.get(agent_id="a", version="draft").configuration.identity)', True),
    "keyword-only arguments": ('c.versions.get("a", "draft")', True),
    "events narrow by type": (
        "with c.conversations.send('c', message='m') as s:\n"
        "    for e in s:\n"
        "        if e.type == 'text.delta':\n"
        "            d: str = e.delta",
        False,
    ),
    "a narrowed event has only its own members": (
        "with c.conversations.send('c', message='m') as s:\n"
        "    for e in s:\n"
        "        if e.type == 'phase.changed':\n"
        "            d: str = e.delta",
        True,
    ),
    "final message is typed": ("with c.conversations.send('c', message='m') as s:\n    t: str = s.final_message().text", False),
    "paginator yields typed items": ('for d in c.documents.list(knowledge_base_id="k"):\n    s: str = d.status', False),
    "misspelt attribute is an error": ('c.versions.get(agent_id="a", version="draft").configuration.instrctions', True),
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
