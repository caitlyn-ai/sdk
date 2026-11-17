// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetConversationInput, GetConversationOutput } from "../models/models_0";
import { GetConversation$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetConversationCommand}.
 */
export interface GetConversationCommandInput extends GetConversationInput {}
/**
 * @public
 *
 * The output of {@link GetConversationCommand}.
 */
export interface GetConversationCommandOutput extends GetConversationOutput, __MetadataBearer {}

/**
 * Gets a conversation: its agent and version, its title and whether it is answering.
 *
 * Read its messages with ListMessages, and follow it with WatchConversation. A conversation the
 * caller may not see is 404, as one that does not exist is.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetConversationCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetConversationCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetConversationInput
 *   conversationId: "STRING_VALUE", // required
 * };
 * const command = new GetConversationCommand(input);
 * const response = await client.send(command);
 * // { // GetConversationOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   conversation: { // Conversation
 * //     id: "STRING_VALUE", // required
 * //     agentId: "STRING_VALUE", // required
 * //     version: "STRING_VALUE", // required
 * //     title: "STRING_VALUE",
 * //     status: "idle" || "responding", // required
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     updatedAt: new Date("TIMESTAMP"),
 * //   },
 * // };
 *
 * ```
 *
 * @param GetConversationCommandInput - {@link GetConversationCommandInput}
 * @returns {@link GetConversationCommandOutput}
 * @see {@link GetConversationCommandInput} for command's `input` shape.
 * @see {@link GetConversationCommandOutput} for command's `response` shape.
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
 * @example A conversation that is answering
 * ```javascript
 * //
 * const input = {
 *   conversationId: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47"
 * };
 * const command = new GetConversationCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   conversation: {
 *     agentId: "GHT7YRWXPL",
 *     createdAt: "2026-11-13T01:02:03.000Z",
 *     id: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *     status: "responding",
 *     title: "Annual leave question",
 *     updatedAt: "2026-11-13T01:04:40.000Z",
 *     version: "live"
 *   }
 * }
 * *\/
 * ```
 *
 * @example A conversation that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   conversationId: "0193a6f2-0000-7000-8000-000000000000"
 * };
 * const command = new GetConversationCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetConversationCommand extends command<GetConversationCommandInput, GetConversationCommandOutput>(
  _ep0,
  _mw0,
  "GetConversation",
  GetConversation$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetConversationInput;
      output: GetConversationOutput;
    };
    sdk: {
      input: GetConversationCommandInput;
      output: GetConversationCommandOutput;
    };
  };
}
