// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListVoicesInput, ListVoicesOutput } from "../models/models_0";
import { ListVoices$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListVoicesCommand}.
 */
export interface ListVoicesCommandInput extends ListVoicesInput {}
/**
 * @public
 *
 * The output of {@link ListVoicesCommand}.
 */
export interface ListVoicesCommandOutput extends ListVoicesOutput, __MetadataBearer {}

/**
 * Lists the cloud voices an agent can speak its answers in.
 *
 * An agent's `voice.voiceId` names one of these when `voice.provider` is `cloud`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListVoicesCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListVoicesCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListVoicesInput
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 * };
 * const command = new ListVoicesCommand(input);
 * const response = await client.send(command);
 * // { // ListVoicesOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // VoiceSummaryList // required
 * //     { // VoiceSummary
 * //       id: "STRING_VALUE", // required
 * //       name: "STRING_VALUE", // required
 * //       language: "STRING_VALUE", // required
 * //       qualities: [ // VoiceQualityList // required
 * //         "natural" || "standard",
 * //       ],
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListVoicesCommandInput - {@link ListVoicesCommandInput}
 * @returns {@link ListVoicesCommandOutput}
 * @see {@link ListVoicesCommandInput} for command's `input` shape.
 * @see {@link ListVoicesCommandOutput} for command's `response` shape.
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
 * @example The first voice
 * ```javascript
 * //
 * const input = {
 *   limit: 1
 * };
 * const command = new ListVoicesCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       id: "Aria",
 *       language: "en-NZ",
 *       name: "Aria",
 *       qualities: [
 *         "natural",
 *         "standard"
 *       ]
 *     }
 *   ],
 *   nextCursor: "c1.MEUCIQDv3c"
 * }
 * *\/
 * ```
 *
 * @example A caller without permission to edit agents
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new ListVoicesCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListVoicesCommand extends command<ListVoicesCommandInput, ListVoicesCommandOutput>(
  _ep0,
  _mw0,
  "ListVoices",
  ListVoices$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListVoicesInput;
      output: ListVoicesOutput;
    };
    sdk: {
      input: ListVoicesCommandInput;
      output: ListVoicesCommandOutput;
    };
  };
}
