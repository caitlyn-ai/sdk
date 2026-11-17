// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { DeleteAgentInput, DeleteAgentOutput } from "../models/models_0";
import { DeleteAgent$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link DeleteAgentCommand}.
 */
export interface DeleteAgentCommandInput extends DeleteAgentInput {}
/**
 * @public
 *
 * The output of {@link DeleteAgentCommand}.
 */
export interface DeleteAgentCommandOutput extends DeleteAgentOutput, __MetadataBearer {}

/**
 * Deletes an agent, its draft and every version.
 *
 * Conversations with the agent are kept. Caitlyn's built-in agents (`native`) are defined by the
 * platform and refused with 403 `PERMISSION_DENIED`. Deleting cannot be undone, and is audited.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, DeleteAgentCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, DeleteAgentCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // DeleteAgentInput
 *   agentId: "STRING_VALUE", // required
 * };
 * const command = new DeleteAgentCommand(input);
 * const response = await client.send(command);
 * // { // DeleteAgentOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param DeleteAgentCommandInput - {@link DeleteAgentCommandInput}
 * @returns {@link DeleteAgentCommandOutput}
 * @see {@link DeleteAgentCommandInput} for command's `input` shape.
 * @see {@link DeleteAgentCommandOutput} for command's `response` shape.
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
 * @example Delete an agent
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL"
 * };
 * const command = new DeleteAgentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* empty *\/ }
 * *\/
 * ```
 *
 * @example An agent that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   agentId: "NOPE0000"
 * };
 * const command = new DeleteAgentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class DeleteAgentCommand extends command<DeleteAgentCommandInput, DeleteAgentCommandOutput>(
  _ep0,
  _mw0,
  "DeleteAgent",
  DeleteAgent$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: DeleteAgentInput;
      output: DeleteAgentOutput;
    };
    sdk: {
      input: DeleteAgentCommandInput;
      output: DeleteAgentCommandOutput;
    };
  };
}
