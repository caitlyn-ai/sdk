# TypeScript examples

The proposal's example code for the ten most important tasks, in TypeScript, for the operations the model has
today. `scripts/test-typescript.sh` type-checks every file here against the generated SDK (strict), so an
example that no longer matches the SDK fails CI.

| File | Task | What the model does not have yet (the server lane that adds it) |
| --- | --- | --- |
| `client-construction.ts` | Creating a client in each sign-in mode | Nothing |
| `task-1-ask-an-agent.ts` | 1. Ask an agent a question and stream a cited, multi-turn answer | `conversations.create` (S2) |
| `task-2-load-documents.ts` | 2. Load documents into a knowledge base and wait until they are searchable | `knowledgeBases.create`, `documents.waitUntilIndexed`, `uploadMany`, `replace`, `delete` (S3) |
| `task-3-change-an-agent.ts` | 3. Change an agent safely: edit the draft, test it, publish it, roll back | `versions.pin`, `publish`, `reset`, `compare`, `list` (S1); `conversations.ask` (S2) |
| `browser-sign-in-server.ts` | Sign in from a browser, on your server (the guide `docs/guides/sign-in-from-a-browser.md`) | Nothing in the model; the guide says what the server is still building |
| `browser-sign-in-page.ts` | Sign in from a browser, in a browser-only app (the same guide) | Browser API clients and cross-origin calls on the server, being built in caitlyn!2062 |

Tasks 4 to 10 (unattended runs, MCP connectors as code, policy reviews, share links, reporting exports, users
and roles, the audit log) need operations no lane has added to the model yet; their examples are added with
those operations (lane X1).
