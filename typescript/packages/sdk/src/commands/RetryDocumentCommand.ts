// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { RetryDocumentInput, RetryDocumentOutput } from "../models/models_0";
import { RetryDocument$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link RetryDocumentCommand}.
 */
export interface RetryDocumentCommandInput extends RetryDocumentInput {}
/**
 * @public
 *
 * The output of {@link RetryDocumentCommand}.
 */
export interface RetryDocumentCommandOutput extends RetryDocumentOutput, __MetadataBearer {}

/**
 * Processes a failed document again; ingestion continues after the response.
 *
 * Returns 202 with the document and the Operation that tracks ingestion. A document that is not
 * `failed` is refused with 409 `CONFLICT`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, RetryDocumentCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, RetryDocumentCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // RetryDocumentInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 * };
 * const command = new RetryDocumentCommand(input);
 * const response = await client.send(command);
 * // { // RetryDocumentOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   document: { // Document
 * //     id: "STRING_VALUE", // required
 * //     knowledgeBaseId: "STRING_VALUE", // required
 * //     name: "STRING_VALUE", // required
 * //     folder: "STRING_VALUE", // required
 * //     status: "pending" || "processing" || "indexed" || "partially_indexed" || "failed" || "deleting", // required
 * //     stage: "STRING_VALUE",
 * //     contentType: "STRING_VALUE",
 * //     byteSize: Number("long"),
 * //     sha256: "STRING_VALUE",
 * //     version: Number("int"),
 * //     versionCount: Number("int"),
 * //     latestVersion: { // LatestVersion
 * //       number: Number("int"), // required
 * //       status: "pending" || "processing" || "indexed" || "partially_indexed" || "failed" || "deleting", // required
 * //       stage: "STRING_VALUE",
 * //       failure: { // DocumentFailure
 * //         code: "file_unreadable" || "processing_interrupted" || "processing_failed" || "cancelled", // required
 * //         message: "STRING_VALUE", // required
 * //       },
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //     },
 * //     superseded: true || false,
 * //     sourceUrl: "STRING_VALUE",
 * //     externalId: "STRING_VALUE",
 * //     metadata: { // DocumentMetadata
 * //       "<keys>": "DOCUMENT_VALUE",
 * //     },
 * //     extraMetadata: { // ExtraMetadata
 * //       "<keys>": "DOCUMENT_VALUE",
 * //     },
 * //     readers: { // Readers
 * //       kind: "inherit" || "public" || "everyone" || "specific", // required
 * //       roles: [ // RoleIdList
 * //         "STRING_VALUE",
 * //       ],
 * //       people: [ // UserIdList
 * //         "STRING_VALUE",
 * //       ],
 * //     },
 * //     inheritedFrom: "STRING_VALUE",
 * //     outOfDate: true || false,
 * //     pageCount: Number("int"),
 * //     durationSeconds: Number("double"),
 * //     processing: { // DocumentProcessing
 * //       kind: "ingest" || "fill_in" || "reprocess" || "reembed", // required
 * //       stage: "pages" || "content" || "pictures" || "transcript" || "frames" || "metadata" || "seams" || "segments" || "passages" || "chunks" || "index" || "document" || "reembed",
 * //       percent: Number("int"), // required
 * //       eta: { // Eta
 * //         seconds: { // NumberRange
 * //           low: Number("double"), // required
 * //           high: Number("double"), // required
 * //         },
 * //       },
 * //       estimate: { // ProcessingEstimate
 * //         durationSeconds: {
 * //           low: Number("double"), // required
 * //           high: Number("double"), // required
 * //         },
 * //         cost: { // Cost
 * //           low: Number("double"), // required
 * //           high: Number("double"), // required
 * //           unit: "usd" || "percent_of_plan", // required
 * //         },
 * //         refined: true || false, // required
 * //       },
 * //       startedAt: new Date("TIMESTAMP"), // required
 * //       updatedAt: new Date("TIMESTAMP"), // required
 * //     },
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     updatedAt: new Date("TIMESTAMP"), // required
 * //     partialFailures: [ // PartialFailureList
 * //       { // PartialFailure
 * //         targetId: "STRING_VALUE",
 * //         code: "STRING_VALUE", // required
 * //         detail: "STRING_VALUE",
 * //       },
 * //     ],
 * //     failure: {
 * //       code: "file_unreadable" || "processing_interrupted" || "processing_failed" || "cancelled", // required
 * //       message: "STRING_VALUE", // required
 * //     },
 * //     etag: "STRING_VALUE", // required
 * //   },
 * //   operation: { // Operation
 * //     id: "STRING_VALUE", // required
 * //     kind: "document_ingestion" || "document_update" || "folder_change" || "permissions_change" || "knowledge_base_deletion" || "layout_aware_search" || "fill_in" || "reprocess", // required
 * //     status: "queued" || "running" || "succeeded" || "completed_with_failures" || "failed" || "cancelled", // required
 * //     target: { // OperationTarget
 * //       type: "knowledge_base" || "folder" || "document", // required
 * //       id: "STRING_VALUE", // required
 * //       knowledgeBaseId: "STRING_VALUE",
 * //     },
 * //     progress: { // OperationProgress
 * //       completed: Number("long"), // required
 * //       total: Number("long"),
 * //       failed: Number("long"),
 * //       unit: "documents" || "passages" || "stages", // required
 * //     },
 * //     percent: Number("int"),
 * //     eta: {
 * //       seconds: {
 * //         low: Number("double"), // required
 * //         high: Number("double"), // required
 * //       },
 * //     },
 * //     costSoFar: {
 * //       low: Number("double"), // required
 * //       high: Number("double"), // required
 * //       unit: "usd" || "percent_of_plan", // required
 * //     },
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     startedAt: new Date("TIMESTAMP"),
 * //     updatedAt: new Date("TIMESTAMP"),
 * //     endedAt: new Date("TIMESTAMP"),
 * //     createdBy: { // Actor
 * //       userId: "STRING_VALUE",
 * //       apiClientId: "STRING_VALUE",
 * //       displayName: "STRING_VALUE", // required
 * //     },
 * //     error: { // OperationError
 * //       code: "STRING_VALUE", // required
 * //       detail: "STRING_VALUE",
 * //     },
 * //     partialFailures: [
 * //       {
 * //         targetId: "STRING_VALUE",
 * //         code: "STRING_VALUE", // required
 * //         detail: "STRING_VALUE",
 * //       },
 * //     ],
 * //   },
 * // };
 *
 * ```
 *
 * @param RetryDocumentCommandInput - {@link RetryDocumentCommandInput}
 * @returns {@link RetryDocumentCommandOutput}
 * @see {@link RetryDocumentCommandInput} for command's `input` shape.
 * @see {@link RetryDocumentCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress. An agent version that live points at
 * (`VERSION_IN_USE`) or that live history names (`VERSION_IN_HISTORY`) cannot be deleted. A
 * document still being ingested takes no new version (`DOCUMENT_INGESTION_IN_PROGRESS`), and an
 * ingestion batch with unresolved items cannot start (`INGESTION_BATCH_UNRESOLVED`).
 * `TARGET_IN_USE` refuses a write to a path an ingestion batch has reserved for a new document
 * (CreateDocument, or UpdateDocument renaming or moving a document onto it) while the batch holds
 * the path; once the batch's reservation has lapsed, the path is free and the write goes ahead. It
 * is also an ingestion batch item's failure when the document its plan found changed, or something
 * else took it, before the batch could act on it. `DOCUMENT_INGESTION_IN_PROGRESS` and
 * `TARGET_IN_USE` answers carry `Retry-After`: for `TARGET_IN_USE`, the seconds left on the batch's
 * reservation. A document whose versions are not numbered yet cannot have one deleted by number
 * (`VERSIONS_NOT_NUMBERED`).
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link InternalError} (server fault)
 *  An unexpected server failure. Not retried by the SDKs.
 *
 * @throws {@link PermissionDeniedError} (client fault)
 *  The caller may not call this operation: it lacks the permission, its credential type may not
 * call it, or the operation is served only on the organisation's primary workspace. Decided before
 * any record is read. A record the caller may not see is 404 instead.
 *
 * @throws {@link ServiceUnavailableError} (server fault)
 *  A dependency is briefly unavailable, or the request's audit event could not be recorded; wait for
 * `Retry-After` and try again.
 *
 * @throws {@link TooManyRequestsError} (client fault)
 *  Too many requests; wait for `Retry-After` and try again.
 *
 * @throws {@link UnauthenticatedError} (client fault)
 *  No credential was sent, or it is expired or not valid.
 *
 * @throws {@link ValidationError} (client fault)
 *  The request is malformed: a member is missing, the wrong type or out of range; it has a member,
 * filter or sort field the operation does not define; its cursor is not valid for this list; it
 * asks to delete `draft` or `live`, which every agent keeps; an agent configuration would be
 * larger than 256 KiB; or a file is meant for a conversation whose agent takes no attachments.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Retry a document that failed
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-5d2e8a90",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new RetryDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   document: {
 *     createdAt: "2026-11-10T01:02:03.000Z",
 *     etag: `"2"`,
 *     folder: "/legal/",
 *     id: "doc-5d2e8a90",
 *     knowledgeBaseId: "KB4T7YQ2WL",
 *     name: "Scanned contract.pdf",
 *     status: "pending",
 *     updatedAt: "2026-11-16T01:02:03.000Z"
 *   },
 *   etag: `"2"`,
 *   operation: {
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     id: "0193a6f2-bbbb-7475-8637-485960718293",
 *     kind: "document_ingestion",
 *     status: "queued"
 *   }
 * }
 * *\/
 * ```
 *
 * @example A document that has not failed
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new RetryDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class RetryDocumentCommand extends command<RetryDocumentCommandInput, RetryDocumentCommandOutput>(
  _ep0,
  _mw0,
  "RetryDocument",
  RetryDocument$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: RetryDocumentInput;
      output: RetryDocumentOutput;
    };
    sdk: {
      input: RetryDocumentCommandInput;
      output: RetryDocumentCommandOutput;
    };
  };
}
