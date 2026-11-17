// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateDocumentVersionInput, CreateDocumentVersionOutput } from "../models/models_0";
import { CreateDocumentVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateDocumentVersionCommand}.
 */
export interface CreateDocumentVersionCommandInput extends CreateDocumentVersionInput {}
/**
 * @public
 *
 * The output of {@link CreateDocumentVersionCommand}.
 */
export interface CreateDocumentVersionCommandOutput extends CreateDocumentVersionOutput, __MetadataBearer {}

/**
 * Adds new bytes to a document as a new version; ingestion continues after the response.
 *
 * The new version becomes the current one once it is indexed; until then the current version keeps
 * serving search. The bytes must be the same file type as the document's: another type is refused
 * with 400 `VALIDATION_FAILED`, because a new type is a new document. While a version is still
 * processing, another is refused with 409 `DOCUMENT_INGESTION_IN_PROGRESS` and `Retry-After`. Bytes
 * the same as the current version's make no new version (`result: unchanged`); bytes the same as an
 * earlier version's bring that version back (`result: restored`).
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateDocumentVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateDocumentVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateDocumentVersionInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 *   idempotencyKey: "STRING_VALUE",
 *   ifMatch: "STRING_VALUE",
 *   uploadId: "STRING_VALUE", // required
 *   note: "STRING_VALUE",
 * };
 * const command = new CreateDocumentVersionCommand(input);
 * const response = await client.send(command);
 * // { // CreateDocumentVersionOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
 * //   result: "created" || "unchanged" || "restored", // required
 * //   version: { // DocumentVersion
 * //     number: Number("int"), // required
 * //     documentId: "STRING_VALUE", // required
 * //     status: "pending" || "processing" || "indexed" || "partially_indexed" || "failed" || "deleting", // required
 * //     stage: "STRING_VALUE",
 * //     contentType: "STRING_VALUE",
 * //     byteSize: Number("long"),
 * //     sha256: "STRING_VALUE",
 * //     current: true || false, // required
 * //     latest: true || false, // required
 * //     note: "STRING_VALUE",
 * //     failure: { // DocumentFailure
 * //       code: "file_unreadable" || "processing_interrupted" || "processing_failed" || "cancelled", // required
 * //       message: "STRING_VALUE", // required
 * //     },
 * //     createdAt: new Date("TIMESTAMP"), // required
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
 * @param CreateDocumentVersionCommandInput - {@link CreateDocumentVersionCommandInput}
 * @returns {@link CreateDocumentVersionCommandOutput}
 * @see {@link CreateDocumentVersionCommandInput} for command's `input` shape.
 * @see {@link CreateDocumentVersionCommandOutput} for command's `response` shape.
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
 * @throws {@link UnprocessableContentError} (client fault)
 *  The idempotency key was already used with a different request body; supplied metadata does not
 * fit the knowledge base's field definitions or limits (`METADATA_FIELD_UNDEFINED`,
 * `METADATA_VALUE_INVALID`, `METADATA_FIELD_PASSAGE_SCOPED`, `METADATA_LIMIT_EXCEEDED`), with one
 * entry per field in `errors`; an ingestion batch item gives both or neither of its content's
 * description and a `fetchUrl` (`BATCH_ITEM_CONTENT_AMBIGUOUS`); or the document guardrail refused
 * a file (`CONTENT_REJECTED`).
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
 * @example Replace a policy with its 2027 edition
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   idempotencyKey: "6e7f8091-a2b3-4c4d-9e5f-60718293a4b5",
 *   ifMatch: `"3"`,
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   note: "2027 edition",
 *   uploadId: "0193a6f2-eeee-7778-8960-718293041526"
 * };
 * const command = new CreateDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   location: "/api/v3/knowledge-bases/KB4T7YQ2WL/documents/doc-3b7f9e21/versions/3",
 *   operation: {
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     id: "0193a6f2-ffff-7879-8a71-829304152637",
 *     kind: "document_ingestion",
 *     status: "queued"
 *   },
 *   result: "created",
 *   version: {
 *     byteSize: 501337,
 *     contentType: "application/pdf",
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     current: false,
 *     documentId: "doc-3b7f9e21",
 *     latest: true,
 *     note: "2027 edition",
 *     number: 3,
 *     sha256: "q8r3Hc5nZ1YbV0LwXk2PjT7sFm9gD4eA6uWiOyKlQhE=",
 *     status: "pending"
 *   }
 * }
 * *\/
 * ```
 *
 * @example A version is still processing
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   uploadId: "0193a6f2-eeee-7778-8960-718293041527"
 * };
 * const command = new CreateDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateDocumentVersionCommand extends command<CreateDocumentVersionCommandInput, CreateDocumentVersionCommandOutput>(
  _ep0,
  _mw0,
  "CreateDocumentVersion",
  CreateDocumentVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateDocumentVersionInput;
      output: CreateDocumentVersionOutput;
    };
    sdk: {
      input: CreateDocumentVersionCommandInput;
      output: CreateDocumentVersionCommandOutput;
    };
  };
}
