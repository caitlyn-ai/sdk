---
type: feat
commit: 5d6a86bb
summary: a beta of every SDK as soon as the API changes, and a clear error for an operation the server does not have
---

- **Betas between releases:** each change to the API is published as a beta, `<next>b<n>` on PyPI and
  `<next>-beta.<n>` on npm (the `beta` dist-tag), on crates.io and as a Go tag, once every SDK's tests pass on it. Stable releases are unchanged.
  See [Install](/getting-started/#install).
- **An operation the server does not have:** a server too old for an operation answers
  [UNKNOWN_OPERATION](/errors/UNKNOWN_OPERATION/), and every SDK raises `NotSupportedByServer` for it, naming the
  release the operation needs, even on a client's first call. See
  [Versions and older servers](/getting-started/#versions-and-older-servers).
