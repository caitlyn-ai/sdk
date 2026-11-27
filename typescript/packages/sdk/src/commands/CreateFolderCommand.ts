// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateFolderInput, CreateFolderOutput } from "../models/models_0";
import { CreateFolder$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateFolderCommand}.
 */
export interface CreateFolderCommandInput extends CreateFolderInput {}
/**
 * @public
 *
 * The output of {@link CreateFolderCommand}.
 */
export interface CreateFolderCommandOutput extends CreateFolderOutput, __MetadataBearer {}

/**
 * Creates a folder; it appears once the work finishes, after the response.
 *
 * Returns 202 with the Operation that tracks it, and `Location` names the Operation. A folder that
 * already exists is refused with 409 `ALREADY_EXISTS`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateFolderCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateFolderCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateFolderInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   idempotencyKey: "STRING_VALUE",
 *   path: "STRING_VALUE", // required
 * };
 * const command = new CreateFolderCommand(input);
 * const response = await client.send(command);
 * // { // CreateFolderOutput
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
 * @param CreateFolderCommandInput - {@link CreateFolderCommandInput}
 * @returns {@link CreateFolderCommandOutput}
 * @see {@link CreateFolderCommandInput} for command's `input` shape.
 * @see {@link CreateFolderCommandOutput} for command's `response` shape.
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
 * @throws {@link UnprocessableContentError} (client fault)
 *  The idempotency key was already used with a different request body; supplied metadata does not
 * fit the knowledge base's field definitions or limits (`METADATA_FIELD_UNDEFINED`,
 * `METADATA_VALUE_INVALID`, `METADATA_FIELD_PASSAGE_SCOPED`, `METADATA_LIMIT_EXCEEDED`), with one
 * entry per field in `errors`; an ingestion batch item gives both or neither of its content's
 * description and a `fetchUrl` (`BATCH_ITEM_CONTENT_AMBIGUOUS`); or the document guardrail refused
 * a file (`CONTENT_REJECTED`); or a grant of a knowledge base to a role that guests or anonymous
 * visitors use is not safe for them (`RBAC_NOT_GUEST_SAFE`), refused for what the grant is, not
 * for what the caller lacks.
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
 * @example Create a folder for leave policies
 * ```javascript
 * //
 * const input = {
 *   idempotencyKey: "0c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   path: "/hr/leave/"
 * };
 * const command = new CreateFolderCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   location: "/api/v3/knowledge-bases/KB4T7YQ2WL/operations/0193a6f2-5555-7e6f-8071-829304152637",
 *   operation: {
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     id: "0193a6f2-5555-7e6f-8071-829304152637",
 *     kind: "folder_change",
 *     status: "queued"
 *   }
 * }
 * *\/
 * ```
 *
 * @example A folder that already exists
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   path: "/hr/"
 * };
 * const command = new CreateFolderCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateFolderCommand extends command<CreateFolderCommandInput, CreateFolderCommandOutput>(
  _ep0,
  _mw0,
  "CreateFolder",
  CreateFolder$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateFolderInput;
      output: CreateFolderOutput;
    };
    sdk: {
      input: CreateFolderCommandInput;
      output: CreateFolderCommandOutput;
    };
  };
}
