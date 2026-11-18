// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { EnableLayoutAwareSearchInput, EnableLayoutAwareSearchOutput } from "../models/models_0";
import { EnableLayoutAwareSearch$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link EnableLayoutAwareSearchCommand}.
 */
export interface EnableLayoutAwareSearchCommandInput extends EnableLayoutAwareSearchInput {}
/**
 * @public
 *
 * The output of {@link EnableLayoutAwareSearchCommand}.
 */
export interface EnableLayoutAwareSearchCommandOutput extends EnableLayoutAwareSearchOutput, __MetadataBearer {}

/**
 * Switches a knowledge base to layout-aware search; rebuilding its passages continues after the
 * response.
 *
 * Returns 202 with the Operation that rebuilds the search vectors of every indexed document. Searches
 * carry on while it runs, and the knowledge base's watch reports it as a job, from the rebuild's own
 * record. Read what it will cost first with EstimateLayoutAwareSearch. Calling it
 * again resumes a rebuild that failed; while a rebuild is running it is refused with 409 `CONFLICT`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, EnableLayoutAwareSearchCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, EnableLayoutAwareSearchCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // EnableLayoutAwareSearchInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 * };
 * const command = new EnableLayoutAwareSearchCommand(input);
 * const response = await client.send(command);
 * // { // EnableLayoutAwareSearchOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
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
 * //     eta: { // Eta
 * //       seconds: { // NumberRange
 * //         low: Number("double"), // required
 * //         high: Number("double"), // required
 * //       },
 * //     },
 * //     costSoFar: { // Cost
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
 * //     partialFailures: [ // PartialFailureList
 * //       { // PartialFailure
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
 * @param EnableLayoutAwareSearchCommandInput - {@link EnableLayoutAwareSearchCommandInput}
 * @returns {@link EnableLayoutAwareSearchCommandOutput}
 * @see {@link EnableLayoutAwareSearchCommandInput} for command's `input` shape.
 * @see {@link EnableLayoutAwareSearchCommandOutput} for command's `response` shape.
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
 * @example Switch to layout-aware search
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new EnableLayoutAwareSearchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   location: "/api/v3/knowledge-bases/KB4T7YQ2WL/operations/0193a6f2-4444-7d5e-8f60-718293041526",
 *   operation: {
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     id: "0193a6f2-4444-7d5e-8f60-718293041526",
 *     kind: "layout_aware_search",
 *     status: "queued"
 *   }
 * }
 * *\/
 * ```
 *
 * @example A rebuild is already running
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new EnableLayoutAwareSearchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class EnableLayoutAwareSearchCommand extends command<EnableLayoutAwareSearchCommandInput, EnableLayoutAwareSearchCommandOutput>(
  _ep0,
  _mw0,
  "EnableLayoutAwareSearch",
  EnableLayoutAwareSearch$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: EnableLayoutAwareSearchInput;
      output: EnableLayoutAwareSearchOutput;
    };
    sdk: {
      input: EnableLayoutAwareSearchCommandInput;
      output: EnableLayoutAwareSearchCommandOutput;
    };
  };
}
