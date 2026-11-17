// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListModelsInput, ListModelsOutput } from "../models/models_0";
import { ListModels$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListModelsCommand}.
 */
export interface ListModelsCommandInput extends ListModelsInput {}
/**
 * @public
 *
 * The output of {@link ListModelsCommand}.
 */
export interface ListModelsCommandOutput extends ListModelsOutput, __MetadataBearer {}

/**
 * Lists the models an agent can use, with the settings each one accepts.
 *
 * Each model says whether it reasons, which reasoning effort levels it offers, which sampling
 * settings it accepts and how many tokens it can write, so an editor shows only the settings that
 * apply. An agent configuration that names a model or setting this list does not offer is refused
 * with 400 `VALIDATION_FAILED`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListModelsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListModelsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListModelsInput
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 * };
 * const command = new ListModelsCommand(input);
 * const response = await client.send(command);
 * // { // ListModelsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // ModelSummaryList // required
 * //     { // ModelSummary
 * //       id: "STRING_VALUE", // required
 * //       name: "STRING_VALUE", // required
 * //       reasoning: "none" || "optional" || "always", // required
 * //       effortLevels: [ // ReasoningEffortList
 * //         "low" || "medium" || "high" || "xhigh" || "max",
 * //       ],
 * //       acceptsTemperature: true || false, // required
 * //       acceptsTopP: true || false, // required
 * //       acceptsTopK: true || false, // required
 * //       maxOutputTokens: Number("int"), // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListModelsCommandInput - {@link ListModelsCommandInput}
 * @returns {@link ListModelsCommandOutput}
 * @see {@link ListModelsCommandInput} for command's `input` shape.
 * @see {@link ListModelsCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
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
 * @example The first model
 * ```javascript
 * //
 * const input = {
 *   limit: 1
 * };
 * const command = new ListModelsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       acceptsTemperature: true,
 *       acceptsTopK: false,
 *       acceptsTopP: false,
 *       effortLevels: [
 *         "low",
 *         "medium",
 *         "high"
 *       ],
 *       id: "claude-sonnet-5-5",
 *       maxOutputTokens: 16384,
 *       name: "Claude Sonnet 5.5",
 *       reasoning: "optional"
 *     }
 *   ],
 *   nextCursor: "c1.MEUCIQDm1a"
 * }
 * *\/
 * ```
 *
 * @example A caller without permission to list models
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new ListModelsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListModelsCommand extends command<ListModelsCommandInput, ListModelsCommandOutput>(
  _ep0,
  _mw0,
  "ListModels",
  ListModels$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListModelsInput;
      output: ListModelsOutput;
    };
    sdk: {
      input: ListModelsCommandInput;
      output: ListModelsCommandOutput;
    };
  };
}
