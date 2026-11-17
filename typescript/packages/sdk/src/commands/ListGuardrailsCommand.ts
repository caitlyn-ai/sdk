// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListGuardrailsInput, ListGuardrailsOutput } from "../models/models_0";
import { ListGuardrails$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListGuardrailsCommand}.
 */
export interface ListGuardrailsCommandInput extends ListGuardrailsInput {}
/**
 * @public
 *
 * The output of {@link ListGuardrailsCommand}.
 */
export interface ListGuardrailsCommandOutput extends ListGuardrailsOutput, __MetadataBearer {}

/**
 * Lists the guardrails an agent version can screen attached documents with.
 *
 * The list holds the platform default and the guardrails available to the workspace. An agent's
 * `contentSafety.guardrail` names one of these by its `id`, or says `default` or `none`. Guardrails
 * are created and changed outside Caitlyn.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListGuardrailsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListGuardrailsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListGuardrailsInput
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 * };
 * const command = new ListGuardrailsCommand(input);
 * const response = await client.send(command);
 * // { // ListGuardrailsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // GuardrailSummaryList // required
 * //     { // GuardrailSummary
 * //       id: "STRING_VALUE", // required
 * //       name: "STRING_VALUE", // required
 * //       version: "STRING_VALUE", // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListGuardrailsCommandInput - {@link ListGuardrailsCommandInput}
 * @returns {@link ListGuardrailsCommandOutput}
 * @see {@link ListGuardrailsCommandInput} for command's `input` shape.
 * @see {@link ListGuardrailsCommandOutput} for command's `response` shape.
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
 * @example The guardrails available to the workspace
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new ListGuardrailsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       id: "default",
 *       name: "Platform default",
 *       version: "1"
 *     },
 *     {
 *       id: "gr-7k2m9q4x1z",
 *       name: "Harbour Freight documents",
 *       version: "3"
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A caller without permission to edit agents
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new ListGuardrailsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListGuardrailsCommand extends command<ListGuardrailsCommandInput, ListGuardrailsCommandOutput>(
  _ep0,
  _mw0,
  "ListGuardrails",
  ListGuardrails$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListGuardrailsInput;
      output: ListGuardrailsOutput;
    };
    sdk: {
      input: ListGuardrailsCommandInput;
      output: ListGuardrailsCommandOutput;
    };
  };
}
