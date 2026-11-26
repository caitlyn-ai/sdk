---
type: fix
summary: timeouts, upload windows and uploads S3 accepts
---

- **Timeouts:** a stalled upload fails after 60 seconds without progress, and an unanswered call after 120 seconds, each retried first, instead of waiting for ever. See [Retries](/retries/#what-is-retried).
- **Uploads S3 accepts:** batch uploads in TypeScript, Go and Rust are accepted by S3 whatever fields the upload policy carries, as Python's always were. See [Build a batch yourself](/guides/how-ingestion-works/#build-a-batch-yourself).
- **Your own upload window:** `uploadWindowSeconds` on a new batch sets how long its uploads have, down to a minute, and the SDK renews the policy halfway through each one. See [Create an ingestion batch](/sdk/create-ingestion-batch/).
- **Cancel one item:** a batch's item can be cancelled on its own, leaving the rest of the batch to carry on. See [Cancelled items](/guides/how-ingestion-works/#cancelled-items).
