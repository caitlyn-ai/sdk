// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { StartIngestionBatchInput, StartIngestionBatchOutput } from "../models/models_0";
import { StartIngestionBatch$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link StartIngestionBatchCommand}.
 */
export interface StartIngestionBatchCommandInput extends StartIngestionBatchInput {}
/**
 * @public
 *
 * The output of {@link StartIngestionBatchCommand}.
 */
export interface StartIngestionBatchCommandOutput extends StartIngestionBatchOutput, __MetadataBearer {}

/**
 * Starts a planned ingestion batch, and returns the upload policy for the items that need bytes.
 *
 * `If-Match` is optional. Without it, the batch starts as it stands; with it, a batch that changed
 * since that ETag is refused with 412. A stale plan is planned again first. Each item's write is then checked and
 * claimed: a new document is reserved at its path, and an existing one is protected by its own
 * version, so a document that changed since the plan becomes a `changed_since_plan` conflict. An item
 * the caller may not write is marked `failed` with `PERMISSION_DENIED`, and the rest carry on; the
 * call still answers 202. Refused with 409
 * `INGESTION_BATCH_UNRESOLVED` while any item is `unresolved`. Returns 202 with the batch and one
 * upload policy: list the items to upload with `filter[status][eq]=awaiting_upload`, upload each to
 * its `objectKey`, then report them with CompleteIngestionBatchUploads.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, StartIngestionBatchCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, StartIngestionBatchCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // StartIngestionBatchInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   ingestionBatchId: "STRING_VALUE", // required
 *   ifMatch: "STRING_VALUE",
 * };
 * const command = new StartIngestionBatchCommand(input);
 * const response = await client.send(command);
 * // { // StartIngestionBatchOutput
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
 * //     etag: "STRING_VALUE", // required
 * //   },
 * //   uploadPolicy: { // UploadPolicy
 * //     uploadUrl: "STRING_VALUE", // required
 * //     formFields: { // FormFieldMap // required
 * //       "<keys>": "STRING_VALUE",
 * //     },
 * //     keyPrefix: "STRING_VALUE", // required
 * //     maxByteSize: Number("long"), // required
 * //     expiresAt: new Date("TIMESTAMP"), // required
 * //   },
 * // };
 *
 * ```
 *
 * @param StartIngestionBatchCommandInput - {@link StartIngestionBatchCommandInput}
 * @returns {@link StartIngestionBatchCommandOutput}
 * @see {@link StartIngestionBatchCommandInput} for command's `input` shape.
 * @see {@link StartIngestionBatchCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress. An agent version that live points at
 * (`VERSION_IN_USE`) or that live history names (`VERSION_IN_HISTORY`) cannot be deleted. A
 * document still being ingested takes no new version (`DOCUMENT_INGESTION_IN_PROGRESS`), an
 * ingestion batch with unresolved items cannot start (`INGESTION_BATCH_UNRESOLVED`), and a document
 * an ingestion batch is working on refuses other writes (`TARGET_IN_USE`); the first and last carry
 * `Retry-After`. A document whose versions are not numbered yet cannot have one deleted by number
 * (`VERSIONS_NOT_NUMBERED`).
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link PreconditionFailedError} (client fault)
 *  `If-Match` does not match the resource's current ETag: it changed since the caller read it.
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
 * @example Start a planned batch
 * ```javascript
 * //
 * const input = {
 *   ifMatch: `"4"`,
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new StartIngestionBatchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   batch: {
 *     awaitMoreItems: false,
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     etag: `"5"`,
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
 *     updatedAt: "2026-11-16T01:03:00.000Z",
 *     uploadsExpireAt: "2026-11-16T01:38:00.000Z"
 *   },
 *   etag: `"5"`,
 *   uploadPolicy: {
 *     expiresAt: "2026-11-16T01:33:00.000Z",
 *     formFields: {
 *       policy: "eyJleHBpcmF0aW9uIjoi",
 *       x-amz-signature: "3f1c"
 *     },
 *     keyPrefix: "batches/0193a6f3-0001-7a2b-8c3d-4e5f60718293/",
 *     maxByteSize: 2147483648,
 *     uploadUrl: "https://uploads.example.com/"
 *   }
 * }
 * *\/
 * ```
 *
 * @example Items still need a decision
 * ```javascript
 * //
 * const input = {
 *   ifMatch: `"3"`,
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new StartIngestionBatchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class StartIngestionBatchCommand extends command<StartIngestionBatchCommandInput, StartIngestionBatchCommandOutput>(
  _ep0,
  _mw0,
  "StartIngestionBatch",
  StartIngestionBatch$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: StartIngestionBatchInput;
      output: StartIngestionBatchOutput;
    };
    sdk: {
      input: StartIngestionBatchCommandInput;
      output: StartIngestionBatchCommandOutput;
    };
  };
}
