// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListIngestionBatchesInput, ListIngestionBatchesOutput } from "../models/models_0";
import { ListIngestionBatches$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListIngestionBatchesCommand}.
 */
export interface ListIngestionBatchesCommandInput extends ListIngestionBatchesInput {}
/**
 * @public
 *
 * The output of {@link ListIngestionBatchesCommand}.
 */
export interface ListIngestionBatchesCommandOutput extends ListIngestionBatchesOutput, __MetadataBearer {}

/**
 * Lists one knowledge base's ingestion batches, newest first.
 *
 * Narrow the list by status.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListIngestionBatchesCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListIngestionBatchesCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListIngestionBatchesInput
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   status: "draft" || "planning" || "planned" || "running" || "succeeded" || "completed_with_failures" || "failed" || "cancelled",
 * };
 * const command = new ListIngestionBatchesCommand(input);
 * const response = await client.send(command);
 * // { // ListIngestionBatchesOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // IngestionBatchList // required
 * //     { // IngestionBatch
 * //       id: "STRING_VALUE", // required
 * //       knowledgeBaseId: "STRING_VALUE", // required
 * //       status: "draft" || "planning" || "planned" || "running" || "succeeded" || "completed_with_failures" || "failed" || "cancelled", // required
 * //       start: "when_planned" || "manual", // required
 * //       awaitMoreItems: true || false, // required
 * //       policy: { // IngestionPolicy
 * //         onConflict: { // ConflictRules
 * //           default: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //           pathTaken: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //           ambiguousContent: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //           duplicatePath: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //           duplicateExternalKey: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //           duplicateInBatch: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //           changedSincePlan: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         },
 * //         onRemove: "remove" || "ask" || "skip",
 * //         onUnchanged: "skip" || "reingest",
 * //         onMoved: "move" || "copy" || "skip",
 * //       },
 * //       scope: { // IngestionBoundary
 * //         folderPath: "STRING_VALUE", // required
 * //       },
 * //       itemCount: Number("long"), // required
 * //       counts: { // IngestionBatchCounts
 * //         byOutcome: { // OutcomeCountMap
 * //           "<keys>": Number("long"),
 * //         },
 * //         byStatus: { // ItemStatusCountMap
 * //           "<keys>": Number("long"),
 * //         },
 * //       },
 * //       percent: Number("int"),
 * //       eta: { // Eta
 * //         seconds: { // NumberRange
 * //           low: Number("double"), // required
 * //           high: Number("double"), // required
 * //         },
 * //       },
 * //       planExpiresAt: new Date("TIMESTAMP"),
 * //       uploadsExpireAt: new Date("TIMESTAMP"),
 * //       createdBy: { // Actor
 * //         userId: "STRING_VALUE",
 * //         apiClientId: "STRING_VALUE",
 * //         displayName: "STRING_VALUE", // required
 * //       },
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //       updatedAt: new Date("TIMESTAMP"), // required
 * //       startedAt: new Date("TIMESTAMP"),
 * //       endedAt: new Date("TIMESTAMP"),
 * //       failure: { // IngestionBatchFailure
 * //         code: "conflict_policy_fail" || "planning_failed" || "internal_error", // required
 * //         message: "STRING_VALUE", // required
 * //       },
 * //       uploadWindowSeconds: Number("int"),
 * //       etag: "STRING_VALUE", // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListIngestionBatchesCommandInput - {@link ListIngestionBatchesCommandInput}
 * @returns {@link ListIngestionBatchesCommandOutput}
 * @see {@link ListIngestionBatchesCommandInput} for command's `input` shape.
 * @see {@link ListIngestionBatchesCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
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
 * @example A knowledge base's running batches
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   status: "running"
 * };
 * const command = new ListIngestionBatchesCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       awaitMoreItems: false,
 *       counts: {
 *         byStatus: {
 *           awaiting_upload: 1,
 *           ingesting: 1,
 *           skipped: 1
 *         }
 *       },
 *       createdAt: "2026-11-16T01:02:03.000Z",
 *       etag: `"5"`,
 *       id: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *       itemCount: 3,
 *       knowledgeBaseId: "KB4T7YQ2WL",
 *       policy: {
 *         onConflict: {
 *           default: "ask"
 *         }
 *       },
 *       start: "manual",
 *       startedAt: "2026-11-16T01:03:00.000Z",
 *       status: "running",
 *       updatedAt: "2026-11-16T01:03:00.000Z",
 *       uploadsExpireAt: "2026-11-16T01:38:00.000Z"
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A knowledge base that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KBNOPE0000"
 * };
 * const command = new ListIngestionBatchesCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListIngestionBatchesCommand extends command<ListIngestionBatchesCommandInput, ListIngestionBatchesCommandOutput>(
  _ep0,
  _mw0,
  "ListIngestionBatches",
  ListIngestionBatches$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListIngestionBatchesInput;
      output: ListIngestionBatchesOutput;
    };
    sdk: {
      input: ListIngestionBatchesCommandInput;
      output: ListIngestionBatchesCommandOutput;
    };
  };
}
