// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CancelOperationInput, CancelOperationOutput } from "../models/models_0";
import { CancelOperation$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CancelOperationCommand}.
 */
export interface CancelOperationCommandInput extends CancelOperationInput {}
/**
 * @public
 *
 * The output of {@link CancelOperationCommand}.
 */
export interface CancelOperationCommandOutput extends CancelOperationOutput, __MetadataBearer {}

/**
 * Cancels an Operation's work.
 *
 * Work not started yet is dropped; work running is stopped where its kind allows. Only
 * `document_ingestion` can be cancelled today: a cancelled first version removes the document, and a
 * cancelled new version leaves the current one serving. Any other kind is refused with 409
 * `OPERATION_NOT_CANCELLABLE`, and a final Operation with 409 `CONFLICT`. Returns the Operation, which
 * becomes `cancelled` once the work has stopped.
 *
 * Cancelling needs what starting that kind of work needs, on the same record, which the server
 * reads from the Operation and checks per kind before it acts: for `document_ingestion`, the
 * permission that started it (`files.create` for a new document, `files.update` for a new version
 * or a retry) and the document's readers; for `document_update`, `files.update` and its readers; for
 * `fill_in`, `reprocess` and `layout_aware_search`, `knowledge-bases.update` and
 * `knowledge-bases.ingestions.update`; for a `folder_change`, the permission of the change
 * (`files.create`, `files.update` or `files.delete`) and the folder's readers; for
 * `permissions_change`, `files.permissions.update` and the record's readers; for
 * `knowledge_base_deletion`, `knowledge-bases.delete`. A caller without it gets 404, as for an
 * Operation it may not see. No one permission is common to every kind, so the operation declares
 * only what reading an Operation needs (`files.read`, as GetOperation), and the per-kind check does
 * the rest.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CancelOperationCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CancelOperationCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CancelOperationInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   operationId: "STRING_VALUE", // required
 * };
 * const command = new CancelOperationCommand(input);
 * const response = await client.send(command);
 * // { // CancelOperationOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
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
 * @param CancelOperationCommandInput - {@link CancelOperationCommandInput}
 * @returns {@link CancelOperationCommandOutput}
 * @see {@link CancelOperationCommandInput} for command's `input` shape.
 * @see {@link CancelOperationCommandOutput} for command's `response` shape.
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
 * @example Stop a document's ingestion
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   operationId: "0193a6f2-2222-7b3c-9d4e-5f6071829304"
 * };
 * const command = new CancelOperationCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   operation: {
 *     createdAt: "2026-11-10T01:02:03.000Z",
 *     id: "0193a6f2-2222-7b3c-9d4e-5f6071829304",
 *     kind: "document_ingestion",
 *     status: "running",
 *     target: {
 *       id: "doc-3b7f9e21",
 *       knowledgeBaseId: "KB4T7YQ2WL",
 *       type: "document"
 *     }
 *   }
 * }
 * *\/
 * ```
 *
 * @example A kind of work that cannot be cancelled
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   operationId: "0193a6f2-3333-7c4d-8e5f-607182930415"
 * };
 * const command = new CancelOperationCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CancelOperationCommand extends command<CancelOperationCommandInput, CancelOperationCommandOutput>(
  _ep0,
  _mw0,
  "CancelOperation",
  CancelOperation$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CancelOperationInput;
      output: CancelOperationOutput;
    };
    sdk: {
      input: CancelOperationCommandInput;
      output: CancelOperationCommandOutput;
    };
  };
}
