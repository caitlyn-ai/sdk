#!/usr/bin/env bash
# What people and scripts see. The commands run as on a terminal 100 columns wide (CAITLYN_FORCE_TTY), so they print
# what a person sees there, here without colour or bold (TERM=dumb), with relative times measured from a fixed moment
# (CAITLYN_DISPLAY_NOW) so the transcript doesn't change from day to day. Each command then runs again with each other
# --output, for the docs' output tabs; the "## <command> <format>" lines mark where each run's output starts.
set -euo pipefail
export CAITLYN_FORCE_TTY=100 CAITLYN_PAGER=cat CAITLYN_COLOR=never TERM=dumb CAITLYN_GLYPHS=unicode CAITLYN_DISPLAY_NOW=2026-11-06T09:00:00Z

each() {
  local name="$1" formats="$2"
  shift 2
  for f in $formats; do
    echo "## $name $f"
    caitlyn "$@" --output "$f"
  done
}

echo "## agents table"
# #region agents
caitlyn agents list
# #endregion
each agents "json yaml" agents list

echo "## detail table"
# #region detail
caitlyn agents draft get GHT7YRWXPL
# #endregion
each detail "json yaml" agents draft get GHT7YRWXPL

echo "## documents table"
# #region table
caitlyn kb documents list --kb KB4T7YQ2WL --limit 3
# #endregion
each documents "json jsonl yaml text" kb documents list --kb KB4T7YQ2WL --limit 3

echo "## document table"
# #region document
caitlyn kb documents get doc-0003 --kb KB4T7YQ2WL
# #endregion
each document "json yaml" kb documents get doc-0003 --kb KB4T7YQ2WL

# As a script runs it, piped
unset CAITLYN_FORCE_TTY

echo "## filter json"
# #region json
caitlyn kb documents get doc-0003 --kb KB4T7YQ2WL --jq '{name, status}'
# #endregion
