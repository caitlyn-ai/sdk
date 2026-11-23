"""The @range check (PROTOCOL.md 3): before sending, a value outside its member's declared range is refused, as the
server would refuse it, so a call that cannot succeed costs no request. The rules come from the model
(codegen/model-support Ranges): ``(where, path, min, max)``, where ``where`` is ``query`` (``path`` a parameter
name) or ``body`` (``path`` a JSON Pointer pattern in which ``*`` stands for any list item or map value). The check
reads the request as it will be sent, so its field errors name the value as the server's would."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any, cast

import httpx

from ._errors import CaitlynError
from ._models import FieldError

Rule = tuple[str, str, float | None, float | None]


def _bounds(lo: float | None, hi: float | None) -> str:
    if lo is not None and hi is not None:
        return f"between {_num(lo)} and {_num(hi)}"
    return f"at least {_num(lo)}" if lo is not None else f"at most {_num(hi)}"


def _num(v: float | None) -> str:
    return str(int(v)) if v is not None and float(v).is_integer() else str(v)


def _outside(v: float, lo: float | None, hi: float | None) -> bool:
    return (lo is not None and v < lo) or (hi is not None and v > hi)


def _escape(s: str) -> str:
    return s.replace("~", "~0").replace("/", "~1")


def range_problems(rules: Sequence[Rule], request: httpx.Request) -> list[FieldError]:
    """Every value of the request outside its rule's range."""
    problems: list[FieldError] = []
    body: Any = None
    if any(r[0] == "body" for r in rules) and request.content:
        try:
            body = json.loads(request.content)
        except ValueError:
            body = None  # not JSON: nothing in it to check
    for where, path, lo, hi in rules:
        if where == "query":
            for raw in request.url.params.get_list(path):
                try:
                    n = float(raw)
                except ValueError:
                    continue
                if _outside(n, lo, hi):
                    problems.append(FieldError(parameter=path, code="VALIDATION_FAILED", detail=f"`{path}` must be {_bounds(lo, hi)}; it is {raw}."))
            continue
        at: list[tuple[str, Any]] = [("", body)]
        for seg in path.split("/")[1:]:
            nxt: list[tuple[str, Any]] = []
            for p, v in at:
                if isinstance(v, dict):
                    obj = cast("dict[str, Any]", v)
                    items: list[tuple[str, Any]] = list(obj.items()) if seg == "*" else ([(seg, obj[seg])] if seg in obj else [])
                    nxt.extend((f"{p}/{_escape(k)}", c) for k, c in items)
                elif isinstance(v, list) and seg == "*":
                    nxt.extend((f"{p}/{i}", c) for i, c in enumerate(cast("list[Any]", v)))
            at = nxt
        for pointer, v in at:
            if isinstance(v, (int, float)) and not isinstance(v, bool) and _outside(v, lo, hi):
                problems.append(FieldError(pointer=pointer, code="VALIDATION_FAILED", detail=f"`{pointer}` must be {_bounds(lo, hi)}; it is {v}."))
    return problems


def check_ranges(rules: Sequence[Rule], request: httpx.Request, error: type[CaitlynError] = CaitlynError) -> None:
    """Raises VALIDATION_FAILED for any value out of range, as ``error`` (the operation's 400 class, ``ValidationError``)
    as the server's refusal would be, but with status 0 and nothing sent (PROTOCOL.md 3 and 6.3)."""
    if not rules:
        return
    problems = range_problems(rules, request)
    if problems:
        if len(problems) == 1:
            detail = problems[0].detail or ""
        else:
            detail = f"{len(problems)} values are out of range. " + " ".join(p.detail or "" for p in problems)
        raise error(f"VALIDATION_FAILED: {detail}", status=0, code="VALIDATION_FAILED", title="The request is not valid", detail=detail, errors=problems)
