---
type: feat
scope: cli
commit: df587f82
summary: the Caitlyn CLI
---

- **Every operation is a command:** `caitlyn`, a single binary released at the SDKs' version, makes each public
  operation a command named after its SDK call (`caitlyn kb documents get <id> --kb <kb>`), with help from the API's
  own documentation. See [The Caitlyn CLI](/cli/).
- **Readable on a terminal, JSON in a pipe:** it prints a table to a terminal and JSON when piped, pages through lists,
  and reports a failure as the API's error with an exit code and the commands to run next. See
  [Output formats](/cli/#output-formats).
- **Install it your way:** an install script, package managers, a container image or signed archives, each release
  verifiable. See [Installing the CLI](/cli/install/).
- **Made for AI agents:** it knows when an agent is driving it, asks before anything that can't be undone, and can
  sign the agent in with a narrower token. See [AI agents and the CLI](/cli/ai-agents/).
- **Your own traces:** it can send its traces to your own OpenTelemetry collector, and says what usage data it sends
  to Caitlyn and how to turn it off. See [Your own traces](/cli/telemetry/#your-own-traces).
