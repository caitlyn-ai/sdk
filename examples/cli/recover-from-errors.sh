#!/usr/bin/env bash
# What a script or an AI agent sees when a command fails: an exit code to branch on, and the error as JSON on stderr,
# with a hint whose next steps are complete commands.
set -uo pipefail

# #region already-exists
# A version name the agent already has: exit code 7
caitlyn agents draft save GHT7YRWXPL --name v12
echo "exit code $?"
# #endregion

# #region stale
# A stale ETag: someone changed the draft after it was read. Exit code 7, and the hint reads it again
caitlyn agents draft update GHT7YRWXPL --if-match '"draft-stale"' --set guidance.instructions=Shorter.
echo "exit code $?"
# #endregion

# #region not-found
# An agent that doesn't exist, or isn't shared with you: exit code 6, and the hint lists the agents
caitlyn agents get NOPE0000
echo "exit code $?"
# #endregion

# #region usage
# A required flag left out: exit code 2, and nothing was sent
caitlyn agents draft save GHT7YRWXPL
echo "exit code $?"
# #endregion
