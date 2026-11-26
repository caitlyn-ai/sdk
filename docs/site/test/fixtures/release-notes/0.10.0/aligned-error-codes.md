---
type: feat
summary: aligned error codes and safer batch uploads
---

- **Public readers:** a folder or document can be opened to anyone, guests and anonymous visitors of a public agent included, with the new `public` readers setting. See [Readers](/sdk/types/readers/).
- **One code per failure:** every error code has a named constant in each SDK, and any failure during a call, an unreadable file or an undecodable response included, reaches you as a Caitlyn error with a code, the language's own error kept as its cause. See [Errors the SDK raises itself](/errors/#errors-the-sdk-raises-itself).
- **Renamed codes:** `INGESTION_FILE_MISSING` (Rust) and `SYNC_FILE_UNKNOWN` (Python) are now `INGESTION_ITEM_HAS_NO_FILE`, and a failed job with no code of its own is `JOB_FAILED`. See [Error codes](/errors/#error-codes).
- **Versions not numbered:** deleting a document version by its number before its versions are numbered gives its own conflict code. See [VERSIONS_NOT_NUMBERED](/errors/VERSIONS_NOT_NUMBERED/).
- **Long uploads finish:** a batch renews its upload policy while any upload is still in flight, and its watch, wait and sync read the batch again after its upload deadline, so a large last file is never failed as expired although it arrives. See [What happens to a batch](/guides/how-ingestion-works/#what-happens-to-a-batch).
- **Enum values to come:** in TypeScript an enum's type accepts values this SDK version does not know yet, so a `switch` that relied on being exhaustive needs a default case. See [Errors](/errors/#handling-errors).
