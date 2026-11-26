#!/usr/bin/env bash
# Look around a knowledge base: its documents, one document's status, and what happens with one that doesn't exist.
set -euo pipefail
# As a person sees it, on a terminal 100 columns wide (see output-formats.sh)
export CAITLYN_FORCE_TTY=100 CAITLYN_PAGER=cat CAITLYN_COLOR=never TERM=dumb CAITLYN_GLYPHS=unicode CAITLYN_DISPLAY_NOW=2026-11-06T09:00:00Z

# Each command again with each other --output, for the docs' output tabs; "## <name> <format>" marks each run
each() {
  local name="$1" formats="$2"
  shift 2
  for f in $formats; do
    echo "## $name $f"
    caitlyn "$@" --output "$f"
  done
}

echo "## list table"
# #region list
caitlyn kb list
# #endregion
each list json kb list

echo "## documents table"
# #region documents
caitlyn kb documents list --kb KB4T7YQ2WL --limit 3
# #endregion
each documents json kb documents list --kb KB4T7YQ2WL --limit 3

echo "## get table"
# #region get
caitlyn kb documents get doc-0003 --kb KB4T7YQ2WL
# #endregion
each get "json yaml" kb documents get doc-0003 --kb KB4T7YQ2WL

# As a script runs it
unset CAITLYN_FORCE_TTY

# #region count
# Every page, one document per line, counted
caitlyn kb documents list --kb KB4T7YQ2WL --all --output jsonl | wc -l | tr -d ' '
# #endregion
