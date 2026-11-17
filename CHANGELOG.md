# [0.9.0](https://github.com/caitlyn-ai/sdk/compare/v0.8.2...v0.9.0) (2026-11-17)


### Features

* SDK 0.9.0: callable scopes, one type per thing, watch and wait, sync and batch upload, and the developer docs ([92e92e5](https://github.com/caitlyn-ai/sdk/commit/92e92e567a38736d5ec757f5a56526a4b35401bd))
  * **Callable scopes:** `kb.documents(id)` names a document without sending anything, and every call on it is at hand. See [Groups and operations](https://build.caitlyn.ai/sdk/#groups-and-operations).
  * **One type per thing:** a document is a `Document` wherever a call returns one, with no separate summary or output type. See [Document](https://build.caitlyn.ai/sdk/types/document/).
  * **Watch and wait:** a document, folder, batch or job has `watch()` for its events and `wait()` for its end. See [Wait for a document](https://build.caitlyn.ai/sdk/helpers/document-wait/) and [Streaming](https://build.caitlyn.ai/streaming/).
  * **Sync and batch upload:** `kb.ingestion.sync` keeps a folder in step, and a batch you build yourself has `upload.estimate` and `upload`. See [How ingestion works](https://build.caitlyn.ai/guides/how-ingestion-works/).
  * **The developer docs:** guides, the SDK and API references, and this changelog. See [Getting started](https://build.caitlyn.ai/getting-started/).


### BREAKING CHANGES

* SDK 0.9.0: callable scopes, one type per thing, watch and wait, sync and batch upload, and the developer docs

## [0.8.2](https://github.com/caitlyn-ai/sdk/compare/v0.8.1...v0.8.2) (2026-11-16)


### Bug Fixes

* **docs:** code in a table never breaks mid-word, and a table too wide for a phone scrolls ([f2bfd62](https://github.com/caitlyn-ai/sdk/commit/f2bfd62956ac75deb72950096003b53703816bf5))

## [0.8.1](https://github.com/caitlyn-ai/sdk/compare/v0.8.0...v0.8.1) (2026-11-15)


### Bug Fixes

* a stream connection open a minute or more restarts the STREAM_LOST count, so a quiet watch outlives the hourly end ([8d40be5](https://github.com/caitlyn-ai/sdk/commit/8d40be5c75fb15f4c957345fbcdc008c444ee07d))

# [0.8.0](https://github.com/caitlyn-ai/sdk/compare/v0.7.0...v0.8.0) (2026-11-15)


### Features

* the SDKs call every operation the v3 server implements, and deliver stream.reset ([156ad34](https://github.com/caitlyn-ai/sdk/commit/156ad341901ff7014f92e09ce5638fd0dd510764))


### BREAKING CHANGES

* the SDKs call every operation the v3 server implements, and deliver stream.reset

# [0.7.0](https://github.com/caitlyn-ai/sdk/compare/v0.6.0...v0.7.0) (2026-11-13)


### Bug Fixes

* **typescript:** CaitlynError declares the fields every Caitlyn error carries ([29ab90e](https://github.com/caitlyn-ai/sdk/commit/29ab90e661817f175b20c207d11c75b5cc423b0d))


### Features

* **auth:** one refresh per refresh token, across clients sharing a store; a workspace URL is its hostname ([11a4464](https://github.com/caitlyn-ai/sdk/commit/11a44640cd999e18071737bca90796edac5a377f))


### BREAKING CHANGES

* **auth:** one refresh per refresh token, across clients sharing a store; a workspace URL is its hostname

# [0.6.0](https://github.com/caitlyn-ai/sdk/compare/v0.5.0...v0.6.0) (2026-11-13)


### Bug Fixes

* **python:** ValidationError.errors is a list of FieldError models ([173e08a](https://github.com/caitlyn-ai/sdk/commit/173e08ad9d3f0b932a111d127cc4d54a780890dc))


### BREAKING CHANGES

* **python:** ValidationError.errors is a list of FieldError models

# [0.5.0](https://github.com/caitlyn-ai/sdk/compare/v0.4.0...v0.5.0) (2026-11-13)


### Features

* **typescript:** the Node build sends requests with Node's built-in fetch ([d7153f2](https://github.com/caitlyn-ai/sdk/commit/d7153f216320ce180e22eb60b7b9abb33fd1bfb7))


### BREAKING CHANGES

* **typescript:** the Node build sends requests with Node's built-in fetch

# [0.4.0](https://github.com/caitlyn-ai/sdk/compare/v0.3.0...v0.4.0) (2026-11-13)


### Features

* **retry:** a client-side retry budget in every SDK ([d8b7bad](https://github.com/caitlyn-ai/sdk/commit/d8b7bad3f22784ef4fb2997bbecd828defc1d0d1))

# [0.3.0](https://github.com/caitlyn-ai/sdk/compare/v0.2.0...v0.3.0) (2026-11-12)


### Features

* **typescript:** every build runs on sdk-core's own runtime, without AWS retries, event streams or endpoint rules ([4a3075a](https://github.com/caitlyn-ai/sdk/commit/4a3075aa4a2986aa38d92edcf0b68a2fbf747f83))
