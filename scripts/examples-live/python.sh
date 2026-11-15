#!/usr/bin/env bash
# The Python examples against a real Caitlyn server (scripts/examples-live.mjs runs this in the toolchain image).
# examples/python/live_checks.py calls each function in examples/python/conversations.py, the code the docs show, and prints `ok <check>` or
# `fail <check>: <why>` for each check. Needs CAITLYN_ENDPOINT, CAITLYN_WORKSPACE, CAITLYN_TOKEN and CAITLYN_AGENT_ID.
set -euo pipefail
cd "$(dirname "$0")/../../python"
uv sync --frozen --quiet
exec uv run --no-sync python ../examples/python/live_checks.py
