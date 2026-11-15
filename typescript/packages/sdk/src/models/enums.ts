// smithy-typescript generated code
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
export const DocumentDeleteStatus = {
  /**
   * The document is now `deleting`, or already was.
   */
  ACCEPTED: "accepted",
  /**
   * The document was not deleted; `code` says why.
   */
  FAILED: "failed",
} as const;
/**
 * @public
 */
export type DocumentDeleteStatus = (typeof DocumentDeleteStatus)[keyof typeof DocumentDeleteStatus];

/**
 * @public
 * @enum
 */
export const CredentialKind = {
  /**
   * An API client's own credential, acting for no person.
   */
  API_CLIENT: "api_client",
  /**
   * A person signed in through a browser: the Caitlyn app, or an SDK in its `session` sign-in mode.
   */
  BROWSER: "browser",
  /**
   * A token issued to an application that a person signed in to with OAuth; it acts for that
   * person, limited to the scopes they approved.
   */
  OAUTH: "oauth",
  /**
   * A personal access token, acting for the person who created it.
   */
  PERSONAL: "personal",
} as const;
/**
 * @public
 */
export type CredentialKind = (typeof CredentialKind)[keyof typeof CredentialKind];

/**
 * @public
 * @enum
 */
export const DocumentFailureCode = {
  /**
   * The file could not be read: it may be damaged, password-protected or not the file type its
   * name says. Check the file, then delete the document and add it again.
   */
  FILE_UNREADABLE: "file_unreadable",
  /**
   * Caitlyn could not finish processing the document. This is not a problem with the file;
   * contact support with the document's identifier.
   */
  PROCESSING_FAILED: "processing_failed",
  /**
   * A temporary problem stopped the document being processed. Delete it and add it again; if it
   * fails again, contact support.
   */
  PROCESSING_INTERRUPTED: "processing_interrupted",
} as const;
/**
 * @public
 */
export type DocumentFailureCode = (typeof DocumentFailureCode)[keyof typeof DocumentFailureCode];

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
   * The document's content could not be processed; `failure` says why. Final.
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
   * The core work failed. Final.
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
   * Finished, but some enrichments did not complete. Final.
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
