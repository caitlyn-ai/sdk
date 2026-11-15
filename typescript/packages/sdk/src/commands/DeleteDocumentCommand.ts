// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { DeleteDocumentInput, DeleteDocumentOutput } from "../models/models_0";
import { DeleteDocument$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link DeleteDocumentCommand}.
 */
export interface DeleteDocumentCommandInput extends DeleteDocumentInput {}
/**
 * @public
 *
 * The output of {@link DeleteDocumentCommand}.
 */
export interface DeleteDocumentCommandOutput extends DeleteDocumentOutput, __MetadataBearer {}

/**
 * Deletes a document; removing it from search continues after the response.
 *
 * Returns 202 with the document in `deleting`; wait for it to be gone with the SDKs'
 * `waitUntilDeleted`. Repeating the call while the document is still `deleting` returns 202 again;
 * once it is gone, 404, as for any record that does not exist.
 *
 * A document still being processed (`pending` or `processing`) cannot be deleted yet: the call is
 * refused with 409 `CONFLICT`. Wait until it is `indexed`, `partially_indexed` or `failed`, for
 * example with the SDKs' `waitUntilIndexed`, then delete it.
 *
 * Needs the files delete permission, read access to the knowledge base and access to the
 * document's folder.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, DeleteDocumentCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, DeleteDocumentCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // DeleteDocumentInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 * };
 * const command = new DeleteDocumentCommand(input);
 * const response = await client.send(command);
 * // { // DeleteDocumentOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   id: "STRING_VALUE", // required
 * //   knowledgeBaseId: "STRING_VALUE", // required
 * //   name: "STRING_VALUE", // required
 * //   folder: "STRING_VALUE", // required
 * //   status: "pending" || "processing" || "indexed" || "partially_indexed" || "failed" || "deleting", // required
 * //   stage: "STRING_VALUE",
 * //   contentType: "STRING_VALUE",
 * //   byteSize: Number("long"),
 * //   sha256: "STRING_VALUE",
 * //   createdAt: new Date("TIMESTAMP"), // required
 * //   updatedAt: new Date("TIMESTAMP"), // required
 * //   partialFailures: [ // PartialFailureList
 * //     { // PartialFailure
 * //       targetId: "STRING_VALUE",
 * //       code: "STRING_VALUE", // required
 * //       detail: "STRING_VALUE",
 * //     },
 * //   ],
 * //   failure: { // DocumentFailure
 * //     code: "file_unreadable" || "processing_interrupted" || "processing_failed", // required
 * //     message: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param DeleteDocumentCommandInput - {@link DeleteDocumentCommandInput}
 * @returns {@link DeleteDocumentCommandOutput}
 * @see {@link DeleteDocumentCommandInput} for command's `input` shape.
 * @see {@link DeleteDocumentCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress.
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
 * filter or sort field the operation does not define; its cursor is not valid for this list; or it
 * asks to delete `draft` or `production`, which every agent keeps.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Delete a document
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new DeleteDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   byteSize: 482113,
 *   contentType: "application/pdf",
 *   createdAt: "2026-11-10T01:02:03.000Z",
 *   folder: "/hr/",
 *   id: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   name: "Leave policy.pdf",
 *   status: "deleting",
 *   updatedAt: "2026-11-15T03:04:05.000Z"
 * }
 * *\/
 * ```
 *
 * @example A document that is already gone, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-00000000",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new DeleteDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @example A document that is still being processed
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-7c2d4e18",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new DeleteDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class DeleteDocumentCommand extends command<DeleteDocumentCommandInput, DeleteDocumentCommandOutput>(
  _ep0,
  _mw0,
  "DeleteDocument",
  DeleteDocument$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: DeleteDocumentInput;
      output: DeleteDocumentOutput;
    };
    sdk: {
      input: DeleteDocumentCommandInput;
      output: DeleteDocumentCommandOutput;
    };
  };
}
