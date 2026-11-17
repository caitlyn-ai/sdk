// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetDocumentVersionInput, GetDocumentVersionOutput } from "../models/models_0";
import { GetDocumentVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetDocumentVersionCommand}.
 */
export interface GetDocumentVersionCommandInput extends GetDocumentVersionInput {}
/**
 * @public
 *
 * The output of {@link GetDocumentVersionCommand}.
 */
export interface GetDocumentVersionCommandOutput extends GetDocumentVersionOutput, __MetadataBearer {}

/**
 * Gets one version of a document.
 *
 * `version` is a number, `current` (the version search uses) or `latest` (the newest, whatever its
 * state). A caller who may not add versions can read only the current version.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetDocumentVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetDocumentVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetDocumentVersionInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE", // required
 * };
 * const command = new GetDocumentVersionCommand(input);
 * const response = await client.send(command);
 * // { // GetDocumentVersionOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
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
 * // };
 *
 * ```
 *
 * @param GetDocumentVersionCommandInput - {@link GetDocumentVersionCommandInput}
 * @returns {@link GetDocumentVersionCommandOutput}
 * @see {@link GetDocumentVersionCommandInput} for command's `input` shape.
 * @see {@link GetDocumentVersionCommandOutput} for command's `response` shape.
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
 * @example The current version
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   version: "current"
 * };
 * const command = new GetDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   version: {
 *     byteSize: 482113,
 *     contentType: "application/pdf",
 *     createdAt: "2026-10-01T22:10:00.000Z",
 *     current: true,
 *     documentId: "doc-3b7f9e21",
 *     latest: true,
 *     number: 2,
 *     status: "indexed"
 *   }
 * }
 * *\/
 * ```
 *
 * @example A version that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   version: "9"
 * };
 * const command = new GetDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetDocumentVersionCommand extends command<GetDocumentVersionCommandInput, GetDocumentVersionCommandOutput>(
  _ep0,
  _mw0,
  "GetDocumentVersion",
  GetDocumentVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetDocumentVersionInput;
      output: GetDocumentVersionOutput;
    };
    sdk: {
      input: GetDocumentVersionCommandInput;
      output: GetDocumentVersionCommandOutput;
    };
  };
}
