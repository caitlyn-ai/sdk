// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetDocumentDownloadInput, GetDocumentDownloadOutput } from "../models/models_0";
import { GetDocumentDownload$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetDocumentDownloadCommand}.
 */
export interface GetDocumentDownloadCommandInput extends GetDocumentDownloadInput {}
/**
 * @public
 *
 * The output of {@link GetDocumentDownloadCommand}.
 */
export interface GetDocumentDownloadCommandOutput extends GetDocumentDownloadOutput, __MetadataBearer {}

/**
 * Gets a short-lived address for a document's bytes, as JSON.
 *
 * Answers 200 with `url`, which works for 15 minutes and needs no credential, so treat it as a
 * secret, and `expiresAt`. Without `version`, the current version's bytes. Unlike
 * GetDocumentContent it never redirects, so a browser script can read the address. The SDKs'
 * `doc.download()` calls it.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetDocumentDownloadCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetDocumentDownloadCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetDocumentDownloadInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE",
 * };
 * const command = new GetDocumentDownloadCommand(input);
 * const response = await client.send(command);
 * // { // GetDocumentDownloadOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   url: "STRING_VALUE", // required
 * //   expiresAt: new Date("TIMESTAMP"), // required
 * // };
 *
 * ```
 *
 * @param GetDocumentDownloadCommandInput - {@link GetDocumentDownloadCommandInput}
 * @returns {@link GetDocumentDownloadCommandOutput}
 * @see {@link GetDocumentDownloadCommandInput} for command's `input` shape.
 * @see {@link GetDocumentDownloadCommandOutput} for command's `response` shape.
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
 * @example Get the address of the current version
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetDocumentDownloadCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   expiresAt: "2026-11-16T01:17:03.000Z",
 *   url: "https://downloads.example.com/doc-3b7f9e21?signature=abc"
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
 * const command = new GetDocumentDownloadCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetDocumentDownloadCommand extends command<GetDocumentDownloadCommandInput, GetDocumentDownloadCommandOutput>(
  _ep0,
  _mw0,
  "GetDocumentDownload",
  GetDocumentDownload$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetDocumentDownloadInput;
      output: GetDocumentDownloadOutput;
    };
    sdk: {
      input: GetDocumentDownloadCommandInput;
      output: GetDocumentDownloadCommandOutput;
    };
  };
}
