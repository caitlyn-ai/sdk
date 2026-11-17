// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListOperationsInput, ListOperationsOutput } from "../models/models_0";
import { ListOperations$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListOperationsCommand}.
 */
export interface ListOperationsCommandInput extends ListOperationsInput {}
/**
 * @public
 *
 * The output of {@link ListOperationsCommand}.
 */
export interface ListOperationsCommandOutput extends ListOperationsOutput, __MetadataBearer {}

/**
 * Lists the Operations on one knowledge base, or one thing in it, newest first.
 *
 * The caller needs read access to the knowledge base. Narrow the list with the target, the kind and
 * the status.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListOperationsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListOperationsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListOperationsInput
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   targetType: "knowledge_base" || "folder" || "document",
 *   targetId: "STRING_VALUE",
 *   kind: "document_ingestion" || "document_update" || "folder_change" || "permissions_change" || "knowledge_base_deletion" || "layout_aware_search" || "fill_in" || "reprocess",
 *   status: "queued" || "running" || "succeeded" || "completed_with_failures" || "failed" || "cancelled",
 * };
 * const command = new ListOperationsCommand(input);
 * const response = await client.send(command);
 * // { // ListOperationsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // OperationList // required
 * //     { // Operation
 * //       id: "STRING_VALUE", // required
 * //       kind: "document_ingestion" || "document_update" || "folder_change" || "permissions_change" || "knowledge_base_deletion" || "layout_aware_search" || "fill_in" || "reprocess", // required
 * //       status: "queued" || "running" || "succeeded" || "completed_with_failures" || "failed" || "cancelled", // required
 * //       target: { // OperationTarget
 * //         type: "knowledge_base" || "folder" || "document", // required
 * //         id: "STRING_VALUE", // required
 * //         knowledgeBaseId: "STRING_VALUE",
 * //       },
 * //       progress: { // OperationProgress
 * //         completed: Number("long"), // required
 * //         total: Number("long"),
 * //         failed: Number("long"),
 * //         unit: "documents" || "passages" || "stages", // required
 * //       },
 * //       percent: Number("int"),
 * //       eta: { // Eta
 * //         seconds: { // NumberRange
 * //           low: Number("double"), // required
 * //           high: Number("double"), // required
 * //         },
 * //       },
 * //       costSoFar: { // Cost
 * //         low: Number("double"), // required
 * //         high: Number("double"), // required
 * //         unit: "usd" || "percent_of_plan", // required
 * //       },
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //       startedAt: new Date("TIMESTAMP"),
 * //       updatedAt: new Date("TIMESTAMP"),
 * //       endedAt: new Date("TIMESTAMP"),
 * //       createdBy: { // Actor
 * //         userId: "STRING_VALUE",
 * //         apiClientId: "STRING_VALUE",
 * //         displayName: "STRING_VALUE", // required
 * //       },
 * //       error: { // OperationError
 * //         code: "STRING_VALUE", // required
 * //         detail: "STRING_VALUE",
 * //       },
 * //       partialFailures: [ // PartialFailureList
 * //         { // PartialFailure
 * //           targetId: "STRING_VALUE",
 * //           code: "STRING_VALUE", // required
 * //           detail: "STRING_VALUE",
 * //         },
 * //       ],
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListOperationsCommandInput - {@link ListOperationsCommandInput}
 * @returns {@link ListOperationsCommandOutput}
 * @see {@link ListOperationsCommandInput} for command's `input` shape.
 * @see {@link ListOperationsCommandOutput} for command's `response` shape.
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
 * @example The running Operations on a knowledge base
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   status: "running"
 * };
 * const command = new ListOperationsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       createdAt: "2026-11-16T01:02:03.000Z",
 *       id: "0193a6f2-4444-7d5e-8f60-718293041526",
 *       kind: "layout_aware_search",
 *       progress: {
 *         completed: 9200,
 *         total: 18350,
 *         unit: "passages"
 *       },
 *       status: "running",
 *       target: {
 *         id: "KB4T7YQ2WL",
 *         type: "knowledge_base"
 *       }
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
 * const command = new ListOperationsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListOperationsCommand extends command<ListOperationsCommandInput, ListOperationsCommandOutput>(
  _ep0,
  _mw0,
  "ListOperations",
  ListOperations$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListOperationsInput;
      output: ListOperationsOutput;
    };
    sdk: {
      input: ListOperationsCommandInput;
      output: ListOperationsCommandOutput;
    };
  };
}
