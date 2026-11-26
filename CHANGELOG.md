# [0.11.0](https://github.com/caitlyn-ai/sdk/compare/v0.10.1...v0.11.0) (2026-11-20)


### Features

* one page of any list, and its pages, in every SDK ([0c580a7](https://github.com/caitlyn-ai/sdk/commit/0c580a75b2f25df25aa76b38a9b15f8097ff8d4d))
  * **One page at a time:** `list(…).page()` makes one request from the input's `cursor` and returns its `items`, `nextCursor` and `hasNextPage`, so a table can show a page without reading the ones before it. See [Read one page](https://build.caitlyn.ai/pagination/#read-one-page).
  * **The next page:** `page.nextPage()` reads the page after it with the same input, and on the last page gives nothing without a request. See [Read the next page](https://build.caitlyn.ai/pagination/#read-the-next-page).
  * **Every page:** `list(…).pages()` yields every page from the cursor, and iterating the list still yields every item, so existing loops are unchanged. See [Iterate the pages](https://build.caitlyn.ai/pagination/#iterate-the-pages).
  * **TypeScript keeps the cursor:** a TypeScript list is now `Paginated`, which no longer throws `nextCursor` away. See [Carry on from a cursor](https://build.caitlyn.ai/pagination/#carry-on-from-a-cursor).


## [0.10.1](https://github.com/caitlyn-ai/sdk/compare/v0.10.0...v0.10.1) (2026-11-18)


### Bug Fixes

* timeouts, upload windows and uploads S3 accepts ([c3b5ebd](https://github.com/caitlyn-ai/sdk/commit/c3b5ebdd0d0dafa44880c2887af80c5afbaeb92a))
  * **Timeouts:** a stalled upload fails after 60 seconds without progress, and an unanswered call after 120 seconds, each retried first, instead of waiting for ever. See [Retries](https://build.caitlyn.ai/retries/#what-is-retried).
  * **Uploads S3 accepts:** batch uploads in TypeScript, Go and Rust are accepted by S3 whatever fields the upload policy carries, as Python's always were. See [Build a batch yourself](https://build.caitlyn.ai/guides/how-ingestion-works/#build-a-batch-yourself).
  * **Your own upload window:** `uploadWindowSeconds` on a new batch sets how long its uploads have, down to a minute, and the SDK renews the policy halfway through each one. See [Create an ingestion batch](https://build.caitlyn.ai/sdk/create-ingestion-batch/).
  * **Cancel one item:** a batch's item can be cancelled on its own, leaving the rest of the batch to carry on. See [Cancelled items](https://build.caitlyn.ai/guides/how-ingestion-works/#cancelled-items).


### New operations

* [Cancel a batch item](https://build.caitlyn.ai/sdk/cancel-ingestion-batch-item/) (`CancelIngestionBatchItem`)


### Changed operations and types

* Each request's `ifMatch` is now `EntityTagCondition` (was `EntityTag`), in 14 operations: [`CreateDocumentVersion`](https://build.caitlyn.ai/sdk/create-document-version/), [`PutAccess`](https://build.caitlyn.ai/sdk/put-access/), [`ReplaceDraftVersion`](https://build.caitlyn.ai/sdk/replace-draft-version/), [`ResetDraftVersion`](https://build.caitlyn.ai/sdk/reset-draft-version/), [`SaveDraftVersion`](https://build.caitlyn.ai/sdk/save-draft-version/), [`StartIngestionBatch`](https://build.caitlyn.ai/sdk/start-ingestion-batch/), [`UpdateAgent`](https://build.caitlyn.ai/sdk/update-agent/), [`UpdateDocument`](https://build.caitlyn.ai/sdk/update-document/), [`UpdateDraftVersion`](https://build.caitlyn.ai/sdk/update-draft-version/), [`UpdateField`](https://build.caitlyn.ai/sdk/update-field/), [`UpdateFolder`](https://build.caitlyn.ai/sdk/update-folder/), [`UpdateIngestionBatch`](https://build.caitlyn.ai/sdk/update-ingestion-batch/), [`UpdateIngestionBatchItem`](https://build.caitlyn.ai/sdk/update-ingestion-batch-item/) and [`UpdateKnowledgeBase`](https://build.caitlyn.ai/sdk/update-knowledge-base/).
* [`CreateIngestionBatch`](https://build.caitlyn.ai/sdk/create-ingestion-batch/): its request adds `uploadWindowSeconds` (`Integer`).
* [`CreateUpload`](https://build.caitlyn.ai/sdk/create-upload/): its request adds `expiresInSeconds` (`Integer`).
* [`IngestionBatch`](https://build.caitlyn.ai/sdk/types/ingestion-batch/): adds `uploadWindowSeconds` (`Integer`).


# [0.10.0](https://github.com/caitlyn-ai/sdk/compare/v0.9.0...v0.10.0) (2026-11-17)


### Features

* aligned error codes and safer batch uploads ([314e0dd](https://github.com/caitlyn-ai/sdk/commit/314e0ddc0d287e44ea77ce5eaa0a8aaed4218859))
  * **Public readers:** a folder or document can be opened to anyone, guests and anonymous visitors of a public agent included, with the new `public` readers setting. See [Readers](https://build.caitlyn.ai/sdk/types/readers/).
  * **One code per failure:** every error code has a named constant in each SDK, and any failure during a call, an unreadable file or an undecodable response included, reaches you as a Caitlyn error with a code, the language's own error kept as its cause. See [Errors the SDK raises itself](https://build.caitlyn.ai/errors/#errors-the-sdk-raises-itself).
  * **Renamed codes:** `INGESTION_FILE_MISSING` (Rust) and `SYNC_FILE_UNKNOWN` (Python) are now `INGESTION_ITEM_HAS_NO_FILE`, and a failed job with no code of its own is `JOB_FAILED`. See [Error codes](https://build.caitlyn.ai/errors/#error-codes).
  * **Versions not numbered:** deleting a document version by its number before its versions are numbered gives its own conflict code. See [VERSIONS_NOT_NUMBERED](https://build.caitlyn.ai/errors/VERSIONS_NOT_NUMBERED/).
  * **Long uploads finish:** a batch renews its upload policy while any upload is still in flight, and its watch, wait and sync read the batch again after its upload deadline, so a large last file is never failed as expired although it arrives. See [What happens to a batch](https://build.caitlyn.ai/guides/how-ingestion-works/#what-happens-to-a-batch).
  * **Enum values to come:** in TypeScript an enum's type accepts values this SDK version does not know yet, so a `switch` that relied on being exhaustive needs a default case. See [Errors](https://build.caitlyn.ai/errors/#handling-errors).


### Changed operations and types

* [`DeleteDocumentVersion`](https://build.caitlyn.ai/sdk/delete-document-version/): can now return [`VERSIONS_NOT_NUMBERED`](https://build.caitlyn.ai/errors/VERSIONS_NOT_NUMBERED/) (409).
* [`IngestionBatch`](https://build.caitlyn.ai/sdk/types/ingestion-batch/): adds `uploadsExpireAt` (`DateTime`).
* [`ReadersKind`](https://build.caitlyn.ai/sdk/types/readers-kind/): adds the value `public`.


### Breaking API changes

* [`IngestionBatchStatus`](https://build.caitlyn.ai/sdk/types/ingestion-batch-status/): drops the value `expired`.


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
