// smithy-typescript generated code
/**
 * @public
 * @enum
 */
export const ClearableDraftField = {
  /**
   * The agent's identity statement.
   */
  IDENTITY: "identity",
} as const;
/**
 * @public
 */
export type ClearableDraftField = (typeof ClearableDraftField)[keyof typeof ClearableDraftField];

/**
 * @public
 * @enum
 */
export const VersionSource = {
  /**
   * Created from an imported agent file.
   */
  IMPORT: "import",
  /**
   * Carried over from the version model before v3.
   */
  MIGRATION: "migration",
  /**
   * Pinned from the draft, without changing production.
   */
  PIN: "pin",
  /**
   * Published, which also made it production.
   */
  PUBLISH: "publish",
} as const;
/**
 * @public
 */
export type VersionSource = (typeof VersionSource)[keyof typeof VersionSource];

/**
 * @public
 * @enum
 */
export const DocumentStatus = {
  /**
   * Being deleted.
   */
  DELETING: "deleting",
  /**
   * The document's content could not be processed. Final.
   */
  FAILED: "failed",
  /**
   * Searchable. Final.
   */
  INDEXED: "indexed",
  /**
   * Searchable, but some enrichments did not complete; see `partialFailures`. Final.
   */
  PARTIALLY_INDEXED: "partially_indexed",
  /**
   * Created; processing has not started.
   */
  PENDING: "pending",
  /**
   * Being processed. `stage` says what the server is doing.
   */
  PROCESSING: "processing",
} as const;
/**
 * @public
 */
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

/**
 * @public
 * @enum
 */
export const OperationKind = {
  /**
   * A document's ingestion: reading, enriching and indexing its content.
   */
  DOCUMENT_INGESTION: "document_ingestion",
} as const;
/**
 * @public
 */
export type OperationKind = (typeof OperationKind)[keyof typeof OperationKind];

/**
 * @public
 * @enum
 */
export const OperationStatus = {
  /**
   * Cancelled before it finished. Final.
   */
  CANCELLED: "cancelled",
  /**
   * The core work failed; see `error`. Final.
   */
  FAILED: "failed",
  /**
   * Waiting to start.
   */
  QUEUED: "queued",
  /**
   * Running.
   */
  RUNNING: "running",
  /**
   * Finished with no failures. Final.
   */
  SUCCEEDED: "succeeded",
  /**
   * Finished, but some enrichments did not complete; see `partialFailures`. Final.
   */
  SUCCEEDED_WITH_FAILURES: "succeeded_with_failures",
} as const;
/**
 * @public
 */
export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus];

/**
 * @public
 * @enum
 */
export const UploadStatus = {
  /**
   * Reserved; the bytes have not arrived.
   */
  AWAITING_BYTES: "awaiting_bytes",
  /**
   * Used by an operation. Final.
   */
  CONSUMED: "consumed",
  /**
   * Not used before `expiresAt`. Final.
   */
  EXPIRED: "expired",
  /**
   * The bytes arrived and matched the checksum.
   */
  RECEIVED: "received",
} as const;
/**
 * @public
 */
export type UploadStatus = (typeof UploadStatus)[keyof typeof UploadStatus];
