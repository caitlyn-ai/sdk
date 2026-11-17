// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { EstimateDocumentVersionInput, EstimateDocumentVersionOutput } from "../models/models_0";
import { EstimateDocumentVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link EstimateDocumentVersionCommand}.
 */
export interface EstimateDocumentVersionCommandInput extends EstimateDocumentVersionInput {}
/**
 * @public
 *
 * The output of {@link EstimateDocumentVersionCommand}.
 */
export interface EstimateDocumentVersionCommandOutput extends EstimateDocumentVersionOutput, __MetadataBearer {}

/**
 * Estimates what replacing a document's file would take and cost, before anything is uploaded.
 *
 * Takes CreateDocumentVersion's arguments, with the file described in place of the upload.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, EstimateDocumentVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, EstimateDocumentVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // EstimateDocumentVersionInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 *   file: { // UploadDescription
 *     name: "STRING_VALUE", // required
 *     contentType: "STRING_VALUE", // required
 *     byteSize: Number("long"), // required
 *     hints: { // IngestionHints
 *       pages: Number("long"),
 *       textPages: Number("long"),
 *       graphicPages: Number("long"),
 *       scannedPages: Number("long"),
 *       pictures: Number("long"),
 *       mediaSeconds: Number("long"),
 *       characters: Number("long"),
 *     },
 *   },
 *   note: "STRING_VALUE",
 * };
 * const command = new EstimateDocumentVersionCommand(input);
 * const response = await client.send(command);
 * // { // EstimateDocumentVersionOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   documents: Number("long"), // required
 * //   pages: Number("long"),
 * //   mediaSeconds: Number("long"),
 * //   documentsOfUnknownLength: Number("long"),
 * //   durationSeconds: { // NumberRange
 * //     low: Number("double"), // required
 * //     high: Number("double"), // required
 * //   },
 * //   cost: { // Cost
 * //     low: Number("double"), // required
 * //     high: Number("double"), // required
 * //     unit: "usd" || "percent_of_plan", // required
 * //   },
 * //   details: "DOCUMENT_VALUE",
 * // };
 *
 * ```
 *
 * @param EstimateDocumentVersionCommandInput - {@link EstimateDocumentVersionCommandInput}
 * @returns {@link EstimateDocumentVersionCommandOutput}
 * @see {@link EstimateDocumentVersionCommandInput} for command's `input` shape.
 * @see {@link EstimateDocumentVersionCommandOutput} for command's `response` shape.
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
 * @example What replacing a policy would take
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   file: {
 *     byteSize: 501337,
 *     contentType: "application/pdf",
 *     hints: {
 *       pages: 15
 *     },
 *     name: "leave-policy-2027.pdf"
 *   },
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new EstimateDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   cost: {
 *     high: 0.09,
 *     low: 0.05,
 *     unit: "usd"
 *   },
 *   documents: 1,
 *   durationSeconds: {
 *     high: 120,
 *     low: 65
 *   },
 *   pages: 15
 * }
 * *\/
 * ```
 *
 * @example A document that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-00000000",
 *   file: {
 *     byteSize: 1,
 *     contentType: "application/pdf",
 *     name: "a.pdf"
 *   },
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new EstimateDocumentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class EstimateDocumentVersionCommand extends command<EstimateDocumentVersionCommandInput, EstimateDocumentVersionCommandOutput>(
  _ep0,
  _mw0,
  "EstimateDocumentVersion",
  EstimateDocumentVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: EstimateDocumentVersionInput;
      output: EstimateDocumentVersionOutput;
    };
    sdk: {
      input: EstimateDocumentVersionCommandInput;
      output: EstimateDocumentVersionCommandOutput;
    };
  };
}
