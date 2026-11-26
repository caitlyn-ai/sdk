---
type: fix
scope: cli
commit: af5de30f
summary: every CLI release is built with the key caitlyn update checks its downloads against
---

- **Updates that work from the first release:** a release can no longer be built without the public key that
  `caitlyn update` uses to check each download, so no release ships a CLI that refuses every update. See
  [Updates](/cli/install/#updates).
