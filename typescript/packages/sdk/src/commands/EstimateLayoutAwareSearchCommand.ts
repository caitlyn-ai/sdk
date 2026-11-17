// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { EstimateLayoutAwareSearchInput, EstimateLayoutAwareSearchOutput } from "../models/models_0";
import { EstimateLayoutAwareSearch$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link EstimateLayoutAwareSearchCommand}.
 */
export interface EstimateLayoutAwareSearchCommandInput extends EstimateLayoutAwareSearchInput {}
/**
 * @public
 *
 * The output of {@link EstimateLayoutAwareSearchCommand}.
 */
export interface EstimateLayoutAwareSearchCommandOutput extends EstimateLayoutAwareSearchOutput, __MetadataBearer {}

/**
 * Estimates what switching a knowledge base to layout-aware search would rebuild, take and cost.
 *
 * `details.searchType` says how the knowledge base searches now.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, EstimateLayoutAwareSearchCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, EstimateLayoutAwareSearchCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // EstimateLayoutAwareSearchInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 * };
 * const command = new EstimateLayoutAwareSearchCommand(input);
 * const response = await client.send(command);
 * // { // EstimateLayoutAwareSearchOutput
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
 * @param EstimateLayoutAwareSearchCommandInput - {@link EstimateLayoutAwareSearchCommandInput}
 * @returns {@link EstimateLayoutAwareSearchCommandOutput}
 * @see {@link EstimateLayoutAwareSearchCommandInput} for command's `input` shape.
 * @see {@link EstimateLayoutAwareSearchCommandOutput} for command's `response` shape.
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
 * @example What switching would rebuild
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new EstimateLayoutAwareSearchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   cost: {
 *     high: 1.8,
 *     low: 1.2,
 *     unit: "usd"
 *   },
 *   details: {
 *     passages: 18350,
 *     searchType: "standard"
 *   },
 *   documents: 412,
 *   durationSeconds: {
 *     high: 1800,
 *     low: 900
 *   }
 * }
 * *\/
 * ```
 *
 * @example A knowledge base that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KBNOPE0000"
 * };
 * const command = new EstimateLayoutAwareSearchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class EstimateLayoutAwareSearchCommand extends command<EstimateLayoutAwareSearchCommandInput, EstimateLayoutAwareSearchCommandOutput>(
  _ep0,
  _mw0,
  "EstimateLayoutAwareSearch",
  EstimateLayoutAwareSearch$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: EstimateLayoutAwareSearchInput;
      output: EstimateLayoutAwareSearchOutput;
    };
    sdk: {
      input: EstimateLayoutAwareSearchCommandInput;
      output: EstimateLayoutAwareSearchCommandOutput;
    };
  };
}
