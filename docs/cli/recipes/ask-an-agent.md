---
pageType: cli
sinceVersion: 5000115000000
resources:
  - agent
  - conversation
integrations: []
operations:
  - CreateConversation
  - SendMessage
  - WatchConversation
---

# Ask an agent

`caitlyn chat` talks to an agent from your terminal. Name the version to talk to: `GHT7YRWXPL` alone is its live version, `GHT7YRWXPL@draft` its draft, which is how you try a change before publishing it.

## A conversation

On a terminal, with no message, `chat` is a conversation you type into. Each answer streams in with its sources; `/attach <file>` sends a file with your next message, `/new` starts a new conversation, and `/quit` or Ctrl-D ends it:

<!-- example: examples/cli/ask-an-agent.sh#session -->
```sh
caitlyn chat GHT7YRWXPL
```

<!-- output: examples/cli/ask-an-agent.sh -->
```text
Type a message. /attach <file>, /new, /quit.
› How much annual leave do staff get?
Staff receive 20 days of annual leave.


Sources
  [1] leave-policy.pdf, page 3

GHT7YRWXPL@live · conversation <conversation-id> (answered by v12)
→ caitlyn chat --conversation <conversation-id> "…"

› /quit
```

## One question

Give the message to ask one question and get its answer, which is what you use in a script or CI. `-` reads the message from stdin:

<!-- example: examples/cli/ask-an-agent.sh#ask -->
```sh
caitlyn chat GHT7YRWXPL@draft "Can I carry leave over to next year?"
```

<!-- output: examples/cli/ask-an-agent.sh -->
```text
Staff receive 20 days of annual leave.


Sources
  [1] leave-policy.pdf, page 3

GHT7YRWXPL@draft · conversation <conversation-id> (answered by v12)
→ caitlyn chat --conversation <conversation-id> "…"
```

## As JSON, for a script

With `--output jsonl`, the answer is its stream of events, one JSON object per line. Carry the conversation on with `--conversation`:

<!-- example: examples/cli/ask-an-agent.sh#json -->
```sh
conversation=$(caitlyn chat GHT7YRWXPL@draft "Can I carry leave over to next year?" --output jsonl \
  | jq -r 'select(.type == "message.completed") | .data.conversationId')
caitlyn chat --conversation "$conversation" "Who approves it?" --output jsonl \
  | jq -c 'select(.type == "citation.added") | .data.citation | {documentName, pageNumber}'
```

## Next

- [Change an agent safely](/cli/recipes/change-an-agent-safely/): try a change on the draft, then publish it.
