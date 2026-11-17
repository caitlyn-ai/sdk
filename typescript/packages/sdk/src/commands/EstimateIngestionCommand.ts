// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { EstimateIngestionInput, EstimateIngestionOutput } from "../models/models_0";
import { EstimateIngestion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link EstimateIngestionCommand}.
 */
export interface EstimateIngestionCommandInput extends EstimateIngestionInput {}
/**
 * @public
 *
 * The output of {@link EstimateIngestionCommand}.
 */
export interface EstimateIngestionCommandOutput extends EstimateIngestionOutput, __MetadataBearer {}

/**
 * Estimates what adding documents would take and cost, before anything is uploaded.
 *
 * Describe each file (its name, type and size, with any hints the client could read). The SDKs call
 * this for `kb.documents.create.estimate(file)` and `kb.ingestion.sync.estimate(…)`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, EstimateIngestionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, EstimateIngestionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // EstimateIngestionInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documents: [ // UploadDescriptionList // required
 *     { // UploadDescription
 *       name: "STRING_VALUE", // required
 *       contentType: "STRING_VALUE", // required
 *       byteSize: Number("long"), // required
 *       hints: { // IngestionHints
 *         pages: Number("long"),
 *         textPages: Number("long"),
 *         graphicPages: Number("long"),
 *         scannedPages: Number("long"),
 *         pictures: Number("long"),
 *         mediaSeconds: Number("long"),
 *         characters: Number("long"),
 *       },
 *     },
 *   ],
 * };
 * const command = new EstimateIngestionCommand(input);
 * const response = await client.send(command);
 * // { // EstimateIngestionOutput
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
 * @param EstimateIngestionCommandInput - {@link EstimateIngestionCommandInput}
 * @returns {@link EstimateIngestionCommandOutput}
 * @see {@link EstimateIngestionCommandInput} for command's `input` shape.
 * @see {@link EstimateIngestionCommandOutput} for command's `response` shape.
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
 * @example What adding one PDF would take
 * ```javascript
 * //
 * const input = {
 *   documents: [
 *     {
 *       byteSize: 482113,
 *       contentType: "application/pdf",
 *       hints: {
 *         pages: 14,
 *         textPages: 14
 *       },
 *       name: "leave-policy.pdf"
 *     }
 *   ],
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new EstimateIngestionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   cost: {
 *     high: 0.08,
 *     low: 0.05,
 *     unit: "usd"
 *   },
 *   documents: 1,
 *   durationSeconds: {
 *     high: 110,
 *     low: 60
 *   },
 *   pages: 14
 * }
 * *\/
 * ```
 *
 * @example A knowledge base that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   documents: [
 *     {
 *       byteSize: 1,
 *       contentType: "application/pdf",
 *       name: "a.pdf"
 *     }
 *   ],
 *   knowledgeBaseId: "KBNOPE0000"
 * };
 * const command = new EstimateIngestionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class EstimateIngestionCommand extends command<EstimateIngestionCommandInput, EstimateIngestionCommandOutput>(
  _ep0,
  _mw0,
  "EstimateIngestion",
  EstimateIngestion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: EstimateIngestionInput;
      output: EstimateIngestionOutput;
    };
    sdk: {
      input: EstimateIngestionCommandInput;
      output: EstimateIngestionCommandOutput;
    };
  };
}
