// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ReprocessDocumentsInput, ReprocessDocumentsOutput } from "../models/models_0";
import { ReprocessDocuments$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ReprocessDocumentsCommand}.
 */
export interface ReprocessDocumentsCommandInput extends ReprocessDocumentsInput {}
/**
 * @public
 *
 * The output of {@link ReprocessDocumentsCommand}.
 */
export interface ReprocessDocumentsCommandOutput extends ReprocessDocumentsOutput, __MetadataBearer {}

/**
 * Processes documents again the newest way; the work continues after the response.
 *
 * Give `outOfDate: true` for every document processed in an older way than the newest, or
 * `documentIds` for particular documents. Each document's current version keeps serving until its
 * new processing is indexed. Returns 202 with the job, which the knowledge base's watch follows;
 * estimate it first with EstimateReprocessDocuments. It is charged for: see the estimate's `cost`, in
 * the form the organisation sees it.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ReprocessDocumentsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ReprocessDocumentsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ReprocessDocumentsInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   idempotencyKey: "STRING_VALUE",
 *   outOfDate: true || false,
 *   documentIds: [ // DocumentIdList
 *     "STRING_VALUE",
 *   ],
 * };
 * const command = new ReprocessDocumentsCommand(input);
 * const response = await client.send(command);
 * // { // ReprocessDocumentsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   job: { // Job
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
 * @param ReprocessDocumentsCommandInput - {@link ReprocessDocumentsCommandInput}
 * @returns {@link ReprocessDocumentsCommandOutput}
 * @see {@link ReprocessDocumentsCommandInput} for command's `input` shape.
 * @see {@link ReprocessDocumentsCommandOutput} for command's `response` shape.
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
 * @example Update every out-of-date document
 * ```javascript
 * //
 * const input = {
 *   idempotencyKey: "a0b1c2d3-e4f5-4a6b-8c7d-8e9fa0b1c2d3",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   outOfDate: true
 * };
 * const command = new ReprocessDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   job: {
 *     createdAt: "2026-11-17T01:02:03.000Z",
 *     id: "0193a6f5-2222-7b3c-9d4e-5f6071829304",
 *     kind: "reprocess",
 *     status: "queued",
 *     target: {
 *       id: "KB4T7YQ2WL",
 *       type: "knowledge_base"
 *     }
 *   }
 * }
 * *\/
 * ```
 *
 * @example Neither out-of-date documents nor particular ones named
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new ReprocessDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ReprocessDocumentsCommand extends command<ReprocessDocumentsCommandInput, ReprocessDocumentsCommandOutput>(
  _ep0,
  _mw0,
  "ReprocessDocuments",
  ReprocessDocuments$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ReprocessDocumentsInput;
      output: ReprocessDocumentsOutput;
    };
    sdk: {
      input: ReprocessDocumentsCommandInput;
      output: ReprocessDocumentsCommandOutput;
    };
  };
}
