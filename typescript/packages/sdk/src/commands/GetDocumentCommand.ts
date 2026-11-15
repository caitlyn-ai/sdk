// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetDocumentInput, GetDocumentOutput } from "../models/models_0";
import { GetDocument$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetDocumentCommand}.
 */
export interface GetDocumentCommandInput extends GetDocumentInput {}
/**
 * @public
 *
 * The output of {@link GetDocumentCommand}.
 */
export interface GetDocumentCommandOutput extends GetDocumentOutput, __MetadataBearer {}

/**
 * Gets one document in a knowledge base, with its status.
 *
 * `status` says where the document is in its lifecycle; `indexed`, `partially_indexed` and `failed`
 * are final. A document in a folder the caller may not see is 404, as one that does not exist is.
 * The SDKs' `waitUntilIndexed` waiter calls this operation until the document is searchable, and
 * `waitUntilDeleted` until it is gone.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetDocumentCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetDocumentCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetDocumentInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 * };
 * const command = new GetDocumentCommand(input);
 * const response = await client.send(command);
 * // { // GetDocumentOutput
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
 * @param GetDocumentCommandInput - {@link GetDocumentCommandInput}
 * @returns {@link GetDocumentCommandOutput}
 * @see {@link GetDocumentCommandInput} for command's `input` shape.
 * @see {@link GetDocumentCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; its cursor is not valid for this list; or it
 * asks to delete `draft` or `production`, which every agent keeps.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example A document that has finished indexing
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetDocumentCommand(input);
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
 *   status: "indexed",
 *   updatedAt: "2026-11-10T01:04:31.000Z"
 * }
 * *\/
 * ```
 *
 * @example A document whose file could not be read
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-5d2e8a90",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   byteSize: 1048576,
 *   contentType: "application/pdf",
 *   createdAt: "2026-11-10T01:02:03.000Z",
 *   failure: {
 *     code: "file_unreadable",
 *     message: "The file could not be read: it may be damaged, password-protected or not the file type its name says. Check the file, then delete the document and add it again."
 *   },
 *   folder: "/legal/",
 *   id: "doc-5d2e8a90",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   name: "Scanned contract.pdf",
 *   status: "failed",
 *   updatedAt: "2026-11-10T01:03:40.000Z"
 * }
 * *\/
 * ```
 *
 * @example A document that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-00000000",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetDocumentCommand extends command<GetDocumentCommandInput, GetDocumentCommandOutput>(
  _ep0,
  _mw0,
  "GetDocument",
  GetDocument$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetDocumentInput;
      output: GetDocumentOutput;
    };
    sdk: {
      input: GetDocumentCommandInput;
      output: GetDocumentCommandOutput;
    };
  };
}
