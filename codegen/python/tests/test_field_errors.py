"""A problem body's field errors are read into FieldError models, the same class the generated SDK exports."""

from __future__ import annotations

import caitlyn
import caitlyn_core
from caitlyn import ValidationError, _operations  # pyright: ignore[reportPrivateUsage]
from caitlyn.models import FieldError
from caitlyn_core._protocol import error_from_problem  # pyright: ignore[reportPrivateUsage]

BODY = {
    "type": "https://build.caitlyn.ai/errors/VALIDATION_FAILED",
    "title": "The request is not valid",
    "status": 400,
    "code": "VALIDATION_FAILED",
    "errors": [
        {"pointer": "/context/0/label", "code": "VALIDATION_FAILED", "detail": "Too long", "hint": "a field this SDK does not model"},
        {"parameter": "filter[staus][eq]", "code": "UNKNOWN_FILTER"},
        {"pointer": "/identity"},  # no code: not readable as a FieldError
        "not an object",
    ],
}


def test_one_field_error_class() -> None:
    assert FieldError is caitlyn.FieldError is caitlyn_core.FieldError


def test_field_errors_are_models() -> None:
    err = error_from_problem(_operations.UPDATE_DRAFT_VERSION, 400, BODY)
    assert isinstance(err, ValidationError)
    assert all(isinstance(e, FieldError) for e in err.errors)
    body, query = err.errors
    assert (body.pointer, body.parameter, body.code, body.detail) == ("/context/0/label", None, "VALIDATION_FAILED", "Too long")
    assert body.raw["hint"] == "a field this SDK does not model"
    assert (query.pointer, query.parameter, query.code) == (None, "filter[staus][eq]", "UNKNOWN_FILTER")
    assert len(err.raw["errors"]) == 4, "entries it cannot read stay in raw"


def test_no_field_errors() -> None:
    assert error_from_problem(_operations.UPDATE_DRAFT_VERSION, 400, {"code": "VALIDATION_FAILED"}).errors == []
    assert error_from_problem(_operations.UPDATE_DRAFT_VERSION, 400, {"code": "VALIDATION_FAILED", "errors": "x"}).errors == []
