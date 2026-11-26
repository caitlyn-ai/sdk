---
type: feat
commit: 2968907d
summary: an application can say which CI system and which AI agent run it, in the user agent
---

- **Name your application:** every SDK takes an app ID, `ci` and `agent` when you create the client, and sends them
  at the end of its user agent (`app/release-bot#2.1.0 ci/gitlab agent/claude-code`), so your workspace can count
  calls from CI and from agents. TypeScript takes an app ID for the first time. See
  [Name your application](/getting-started/#name-your-application).
- **Checked before anything is sent:** a `ci` or `agent` value outside 1 to 32 characters of `a-z`, `0-9` and `-`
  fails when the client is created. See [Name your application](/getting-started/#name-your-application).
