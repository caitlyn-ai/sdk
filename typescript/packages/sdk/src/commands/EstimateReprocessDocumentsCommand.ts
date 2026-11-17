// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { EstimateReprocessDocumentsInput, EstimateReprocessDocumentsOutput } from "../models/models_0";
import { EstimateReprocessDocuments$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link EstimateReprocessDocumentsCommand}.
 */
export interface EstimateReprocessDocumentsCommandInput extends EstimateReprocessDocumentsInput {}
/**
 * @public
 *
 * The output of {@link EstimateReprocessDocumentsCommand}.
 */
export interface EstimateReprocessDocumentsCommandOutput extends EstimateReprocessDocumentsOutput, __MetadataBearer {}

/**
 * Estimates what processing documents again would take and cost, and what it would improve.
 *
 * Takes the same arguments as ReprocessDocuments. `details` lists the improvements the newest
 * processing brings.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, EstimateReprocessDocumentsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, EstimateReprocessDocumentsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // EstimateReprocessDocumentsInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   outOfDate: true || false,
 *   documentIds: [ // DocumentIdList
 *     "STRING_VALUE",
 *   ],
 * };
 * const command = new EstimateReprocessDocumentsCommand(input);
 * const response = await client.send(command);
 * // { // EstimateReprocessDocumentsOutput
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
 * @param EstimateReprocessDocumentsCommandInput - {@link EstimateReprocessDocumentsCommandInput}
 * @returns {@link EstimateReprocessDocumentsCommandOutput}
 * @see {@link EstimateReprocessDocumentsCommandInput} for command's `input` shape.
 * @see {@link EstimateReprocessDocumentsCommandOutput} for command's `response` shape.
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
 * @example What updating the out-of-date documents would cost
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   outOfDate: true
 * };
 * const command = new EstimateReprocessDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   cost: {
 *     high: 1.7,
 *     low: 1.1,
 *     unit: "usd"
 *   },
 *   documents: 12,
 *   durationSeconds: {
 *     high: 1500,
 *     low: 900
 *   },
 *   pages: 340
 * }
 * *\/
 * ```
 *
 * @example A knowledge base that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KBNOPE0000",
 *   outOfDate: true
 * };
 * const command = new EstimateReprocessDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class EstimateReprocessDocumentsCommand extends command<EstimateReprocessDocumentsCommandInput, EstimateReprocessDocumentsCommandOutput>(
  _ep0,
  _mw0,
  "EstimateReprocessDocuments",
  EstimateReprocessDocuments$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: EstimateReprocessDocumentsInput;
      output: EstimateReprocessDocumentsOutput;
    };
    sdk: {
      input: EstimateReprocessDocumentsCommandInput;
      output: EstimateReprocessDocumentsCommandOutput;
    };
  };
}
