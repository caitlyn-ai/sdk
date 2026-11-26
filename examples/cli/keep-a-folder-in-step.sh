#!/usr/bin/env bash
# Keep a folder in step with a knowledge base: plan, upload what changed, and remove what the folder no longer has.
# needs: kb sync
set -euo pipefail
handbook=$(mktemp -d)
printf '# Leave\n\nUp to 5 days carry over.\n' > "$handbook/leave.md"
printf '# Pay\n\nPaid fortnightly.\n' > "$handbook/pay.md"

# As a person sees it, on a terminal 100 columns wide (see output-formats.sh)
export CAITLYN_FORCE_TTY=100 CAITLYN_PAGER=cat CAITLYN_COLOR=never TERM=dumb CAITLYN_GLYPHS=unicode CAITLYN_DISPLAY_NOW=2026-11-06T09:00:00Z

# #region sync
caitlyn kb sync KB4T7YQ2WL "$handbook" --folder /handbook/ --remove-missing --yes
# #endregion

# As CI runs it
unset CAITLYN_FORCE_TTY

# #region ci
# In CI it never asks: a plan with conflicts is written to plan.json, and the command exits 3
caitlyn kb sync KB4T7YQ2WL "$handbook" --folder /handbook/ --report json=plan.json --yes || echo "exit code $?"
# #endregion
