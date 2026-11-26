#!/usr/bin/env bash
# Ask an agent a question and stream its cited answer, then carry on the conversation as JSON for a script.
# needs: chat
set -euo pipefail

# A person at a terminal: chat with no message is a conversation they type into. It needs a real terminal, so this
# example gives it one (script(1)), types the question and /quit, and drops the terminal's control sequences (the
# progress line that erases itself) so the transcript reads as the session does. "## <name>" lines mark the output.
export CAITLYN_COLOR=never TERM=dumb CAITLYN_GLYPHS=unicode
caitlyn() {
  if [ "$*" = "chat GHT7YRWXPL" ]; then
    (sleep 1; printf 'How much annual leave do staff get?\n'; sleep 2; printf '/quit\n') \
      | script -qec "stty cols 100 2> /dev/null; command caitlyn chat GHT7YRWXPL" /dev/null \
      | tr -d '\r' | perl -pe 's/\e\[2K.*?\e\[2K//g; s/\e\[[0-9;]*[A-Za-z]//g'
  else
    command caitlyn "$@"
  fi
}

echo "## session"
# #region session
caitlyn chat GHT7YRWXPL
# #endregion
unset -f caitlyn

# One question, as a person sees it on a terminal 100 columns wide (see output-formats.sh)
export CAITLYN_FORCE_TTY=100
echo "## ask"
# #region ask
caitlyn chat GHT7YRWXPL@draft "Can I carry leave over to next year?"
# #endregion
unset CAITLYN_FORCE_TTY

echo "## json"
# #region json
conversation=$(caitlyn chat GHT7YRWXPL@draft "Can I carry leave over to next year?" --output jsonl \
  | jq -r 'select(.type == "message.completed") | .data.conversationId')
caitlyn chat --conversation "$conversation" "Who approves it?" --output jsonl \
  | jq -c 'select(.type == "citation.added") | .data.citation | {documentName, pageNumber}'
# #endregion
