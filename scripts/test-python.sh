#!/usr/bin/env bash
# Python: sync the uv workspace, pyright --strict over the runtime, the generated SDK and the harness, the
# generator-level tests, the developer docs' Python examples, then the conformance harness. Writes build/conformance/python.xml.
set -euo pipefail
cd "$(dirname "$0")/../python"
mkdir -p ../build/conformance
uv sync --frozen --quiet
uv run pyright
# The developer docs' Python: the hand-written examples and the API reference's programs (scripts/docs-snippets.mjs)
node ../scripts/prepare-model.mjs > /dev/null
node ../scripts/docs-snippets.mjs python
uv run pyright ../examples/python
uv run pytest -c pyproject.toml -q -p no:cacheprovider ../codegen/python/tests
uv run pytest -c pyproject.toml -q -p no:cacheprovider ../conformance/python --junitxml=../build/conformance/python.xml
