// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CancelIngestionBatchInput, CancelIngestionBatchOutput } from "../models/models_0";
import { CancelIngestionBatch$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CancelIngestionBatchCommand}.
 */
export interface CancelIngestionBatchCommandInput extends CancelIngestionBatchInput {}
/**
 * @public
 *
 * The output of {@link CancelIngestionBatchCommand}.
 */
export interface CancelIngestionBatchCommandOutput extends CancelIngestionBatchOutput, __MetadataBearer {}

/**
 * Cancels an ingestion batch.
 *
 * Items not yet uploaded are stopped, and their reserved documents released. With `stopRunning`,
 * items already being ingested are stopped too: a stopped new document is removed, and a stopped new
 * version leaves the current one serving. Otherwise, work already being ingested finishes. Returns
 * 202 with the batch, which becomes `cancelled` once nothing is left running. A final batch is
 * refused with 409 `CONFLICT`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CancelIngestionBatchCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CancelIngestionBatchCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CancelIngestionBatchInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   ingestionBatchId: "STRING_VALUE", // required
 *   stopRunning: true || false,
 * };
 * const command = new CancelIngestionBatchCommand(input);
 * const response = await client.send(command);
 * // { // CancelIngestionBatchOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   batch: { // IngestionBatch
 * //     id: "STRING_VALUE", // required
 * //     knowledgeBaseId: "STRING_VALUE", // required
 * //     status: "draft" || "planning" || "planned" || "running" || "succeeded" || "completed_with_failures" || "failed" || "cancelled", // required
 * //     start: "when_planned" || "manual", // required
 * //     awaitMoreItems: true || false, // required
 * //     policy: { // IngestionPolicy
 * //       onConflict: { // ConflictRules
 * //         default: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         pathTaken: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         ambiguousContent: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         duplicatePath: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         duplicateExternalKey: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         duplicateInBatch: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         changedSincePlan: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //       },
 * //       onRemove: "remove" || "ask" || "skip",
 * //       onUnchanged: "skip" || "reingest",
 * //       onMoved: "move" || "copy" || "skip",
 * //     },
 * //     scope: { // IngestionBoundary
 * //       folderPath: "STRING_VALUE", // required
 * //     },
 * //     itemCount: Number("long"), // required
 * //     counts: { // IngestionBatchCounts
 * //       byOutcome: { // OutcomeCountMap
 * //         "<keys>": Number("long"),
 * //       },
 * //       byStatus: { // ItemStatusCountMap
 * //         "<keys>": Number("long"),
 * //       },
 * //     },
 * //     percent: Number("int"),
 * //     eta: { // Eta
 * //       seconds: { // NumberRange
 * //         low: Number("double"), // required
 * //         high: Number("double"), // required
 * //       },
 * //     },
 * //     planExpiresAt: new Date("TIMESTAMP"),
 * //     uploadsExpireAt: new Date("TIMESTAMP"),
 * //     createdBy: { // Actor
 * //       userId: "STRING_VALUE",
 * //       apiClientId: "STRING_VALUE",
 * //       displayName: "STRING_VALUE", // required
 * //     },
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     updatedAt: new Date("TIMESTAMP"), // required
 * //     startedAt: new Date("TIMESTAMP"),
 * //     endedAt: new Date("TIMESTAMP"),
 * //     failure: { // IngestionBatchFailure
 * //       code: "conflict_policy_fail" || "planning_failed" || "internal_error", // required
 * //       message: "STRING_VALUE", // required
 * //     },
 * //     uploadWindowSeconds: Number("int"),
 * //     etag: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param CancelIngestionBatchCommandInput - {@link CancelIngestionBatchCommandInput}
 * @returns {@link CancelIngestionBatchCommandOutput}
 * @see {@link CancelIngestionBatchCommandInput} for command's `input` shape.
 * @see {@link CancelIngestionBatchCommandOutput} for command's `response` shape.
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
 * @example Cancel a batch and stop what is running
 * ```javascript
 * //
 * const input = {
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   stopRunning: true
 * };
 * const command = new CancelIngestionBatchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   batch: {
 *     awaitMoreItems: false,
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     etag: `"6"`,
 *     id: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *     itemCount: 3,
 *     knowledgeBaseId: "KB4T7YQ2WL",
 *     policy: {
 *       onConflict: {
 *         default: "skip"
 *       }
 *     },
 *     start: "manual",
 *     startedAt: "2026-11-16T01:03:00.000Z",
 *     status: "running",
 *     updatedAt: "2026-11-16T01:05:00.000Z"
 *   },
 *   etag: `"6"`
 * }
 * *\/
 * ```
 *
 * @example A batch that already finished
 * ```javascript
 * //
 * const input = {
 *   ingestionBatchId: "0193a6f3-0002-7a2b-8c3d-4e5f60718293",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new CancelIngestionBatchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CancelIngestionBatchCommand extends command<CancelIngestionBatchCommandInput, CancelIngestionBatchCommandOutput>(
  _ep0,
  _mw0,
  "CancelIngestionBatch",
  CancelIngestionBatch$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CancelIngestionBatchInput;
      output: CancelIngestionBatchOutput;
    };
    sdk: {
      input: CancelIngestionBatchCommandInput;
      output: CancelIngestionBatchCommandOutput;
    };
  };
}
