// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { DeleteFieldInput, DeleteFieldOutput } from "../models/models_0";
import { DeleteField$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link DeleteFieldCommand}.
 */
export interface DeleteFieldCommandInput extends DeleteFieldInput {}
/**
 * @public
 *
 * The output of {@link DeleteFieldCommand}.
 */
export interface DeleteFieldCommandOutput extends DeleteFieldOutput, __MetadataBearer {}

/**
 * Removes a metadata field, with every value documents hold for it and every lock on those values.
 *
 * Deleting cannot be undone. Agents and searches stop using the field at once.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, DeleteFieldCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, DeleteFieldCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // DeleteFieldInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   fieldKey: "STRING_VALUE", // required
 * };
 * const command = new DeleteFieldCommand(input);
 * const response = await client.send(command);
 * // { // DeleteFieldOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param DeleteFieldCommandInput - {@link DeleteFieldCommandInput}
 * @returns {@link DeleteFieldCommandOutput}
 * @see {@link DeleteFieldCommandInput} for command's `input` shape.
 * @see {@link DeleteFieldCommandOutput} for command's `response` shape.
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
 * @example Remove a field
 * ```javascript
 * //
 * const input = {
 *   fieldKey: "region",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new DeleteFieldCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* empty *\/ }
 * *\/
 * ```
 *
 * @example A field the knowledge base does not define
 * ```javascript
 * //
 * const input = {
 *   fieldKey: "nope",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new DeleteFieldCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class DeleteFieldCommand extends command<DeleteFieldCommandInput, DeleteFieldCommandOutput>(
  _ep0,
  _mw0,
  "DeleteField",
  DeleteField$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: DeleteFieldInput;
      output: DeleteFieldOutput;
    };
    sdk: {
      input: DeleteFieldCommandInput;
      output: DeleteFieldCommandOutput;
    };
  };
}
