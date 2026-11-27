// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { DeleteDocumentVersionInput, DeleteDocumentVersionOutput } from "../models/models_0";
import { DeleteDocumentVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link DeleteDocumentVersionCommand}.
 */
export interface DeleteDocumentVersionCommandInput extends DeleteDocumentVersionInput {}
/**
 * @public
 *
 * The output of {@link DeleteDocumentVersionCommand}.
 */
export interface DeleteDocumentVersionCommandOutput extends DeleteDocumentVersionOutput, __MetadataBearer {}

/**
 * Deletes one version of a document that is neither current nor processing.
 *
 * The version, its passages and its renders are removed; its bytes are kept while another version
 * or document has the same ones. The current version and a version still processing are refused with
 * 409 `CONFLICT`; to remove the current version, delete the document. Like every change, it is
 * audited.
 *
 * A version's number is its place in upload order, so deleting by number needs the document's
 * versions to be numbered already: until they are, a number is refused with 409
 * `VERSIONS_NOT_NUMBERED`, because deleting would shift every later number; try again later.
 *
 * Only a version number is accepted: `latest` and `current` are refused with 400
 * `VALIDATION_FAILED`, because the version they name changes after each delete, so a retried
 * request could delete a second version.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, DeleteDocumentVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, DeleteDocumentVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // DeleteDocumentVersionInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE", // required
 * };
 * const command = new DeleteDocumentVersionCommand(input);
 * const response = await client.send(command);
 * // { // DeleteDocumentVersionOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param DeleteDocumentVersionCommandInput - {@link DeleteDocumentVersionCommandInput}
 * @returns {@link DeleteDocumentVersionCommandOutput}
 * @see {@link DeleteDocumentVersionCommandInput} for command's `input` shape.
 * @see {@link DeleteDocumentVersionCommandOutput} for command's `response` shape.
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
 * @example Delete an old version
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   version: "1"
 * };
 * const command = new DeleteDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* empty *\/ }
 * *\/
 * ```
 *
 * @example The current version, by its number
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   version: "2"
 * };
 * const command = new DeleteDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @example A version number before the document's versions are numbered
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   version: "1"
 * };
 * const command = new DeleteDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class DeleteDocumentVersionCommand extends command<DeleteDocumentVersionCommandInput, DeleteDocumentVersionCommandOutput>(
  _ep0,
  _mw0,
  "DeleteDocumentVersion",
  DeleteDocumentVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: DeleteDocumentVersionInput;
      output: DeleteDocumentVersionOutput;
    };
    sdk: {
      input: DeleteDocumentVersionCommandInput;
      output: DeleteDocumentVersionCommandOutput;
    };
  };
}
