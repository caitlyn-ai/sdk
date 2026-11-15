// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { DeleteAgentVersionInput, DeleteAgentVersionOutput } from "../models/models_0";
import { DeleteAgentVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link DeleteAgentVersionCommand}.
 */
export interface DeleteAgentVersionCommandInput extends DeleteAgentVersionInput {}
/**
 * @public
 *
 * The output of {@link DeleteAgentVersionCommand}.
 */
export interface DeleteAgentVersionCommandOutput extends DeleteAgentVersionOutput, __MetadataBearer {}

/**
 * Deletes a named version.
 *
 * Any named version can be deleted, including the one production is running; production carries
 * on unchanged. `draft` and `production`, which every agent keeps, are refused with 400
 * `VERSION_NOT_DELETABLE`. Production history entries that name the version are never deleted or
 * changed, and still read as they did. Like every change, it is audited.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, DeleteAgentVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, DeleteAgentVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // DeleteAgentVersionInput
 *   agentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE", // required
 * };
 * const command = new DeleteAgentVersionCommand(input);
 * const response = await client.send(command);
 * // { // DeleteAgentVersionOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param DeleteAgentVersionCommandInput - {@link DeleteAgentVersionCommandInput}
 * @returns {@link DeleteAgentVersionCommandOutput}
 * @see {@link DeleteAgentVersionCommandInput} for command's `input` shape.
 * @see {@link DeleteAgentVersionCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; its cursor is not valid for this list; or it
 * asks to delete `draft` or `production`, which every agent keeps.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Delete a version that is no longer used
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   version: "september-trial"
 * };
 * const command = new DeleteAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* empty *\/ }
 * *\/
 * ```
 *
 * @example The draft, which every agent keeps
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   version: "draft"
 * };
 * const command = new DeleteAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class DeleteAgentVersionCommand extends command<DeleteAgentVersionCommandInput, DeleteAgentVersionCommandOutput>(
  _ep0,
  _mw0,
  "DeleteAgentVersion",
  DeleteAgentVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: DeleteAgentVersionInput;
      output: DeleteAgentVersionOutput;
    };
    sdk: {
      input: DeleteAgentVersionCommandInput;
      output: DeleteAgentVersionCommandOutput;
    };
  };
}
