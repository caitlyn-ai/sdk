---
type: fix
scope: cli
summary: waiting on a new knowledge base, saving a document to a file, estimates without a price, input skeletons without the required flags, every missing confirmation at once, and chat that stays a conversation on a terminal
---

- **Waiting on a new knowledge base:** `caitlyn knowledge-bases create --wait` follows the knowledge base it just
  created until it's ready, rather than stopping because no knowledge base was named. See
  [knowledge-bases create](/cli/reference/knowledge-bases/#create).
- **Saving a document:** `caitlyn kb documents download` saves the document's bytes, to its own name in the current
  folder or to `--out <file>` (`-O`), never overwriting a file without `--force`. `--out -` writes them to stdout, but
  not to a terminal unless they're text, and `--url-only` prints the address as before. `-o` is still the output
  format, and a file name given to it says to use `--out`. See
  [knowledge-bases documents download](/cli/reference/knowledge-bases/documents/#download).
- **Estimates without a price:** `caitlyn kb sync --estimate` prints the plan and how much it would upload when
  pricing is unavailable, says the price is unavailable, and exits 0. See
  [kb sync](/cli/reference/knowledge-bases/#sync).
- **Input skeletons:** `--generate-input` prints a command's input skeleton without its required flags or
  `--if-match`: finding them out is what it's for. See
  [knowledge-bases documents update](/cli/reference/knowledge-bases/documents/#update).
- **Every missing confirmation at once:** in CI or an agent's session, a command that needs `--yes` and
  `--confirm <id>` says so in one error, and its next step gives both, so one retry is enough. See
  [Exit codes](/cli/exit-codes/).
- **Naming a published draft:** when the workspace refuses to publish a draft without a name, the error says to give
  `--name`, with the command to run. See [agents draft publish](/cli/reference/agents/draft/#publish).
- **Chat on a terminal is a conversation:** `caitlyn chat` renders the answer, and opens a conversation when given no
  message, whatever output your configuration or `CAITLYN_OUTPUT` sets; so do `events tail` and the `watch`
  commands. `--output` on the command itself, piped output, CI and AI agents get the events as data, as before. See
  [Conversations and streams](/cli/#conversations-and-streams).
