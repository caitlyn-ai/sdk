// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateConversationInput, CreateConversationOutput } from "../models/models_0";
import { CreateConversation$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateConversationCommand}.
 */
export interface CreateConversationCommandInput extends CreateConversationInput {}
/**
 * @public
 *
 * The output of {@link CreateConversationCommand}.
 */
export interface CreateConversationCommandOutput extends CreateConversationOutput, __MetadataBearer {}

/**
 * Starts a conversation with one version of an agent.
 *
 * Send messages to it with `SendMessage`, and watch it with `WatchConversation`. The conversation
 * belongs to the caller that created it: the person, or the API client's own credential.
 *
 * `version` names the agent version that answers. Today only `draft` can be used: `production`
 * and named versions arrive with agent versions, and asking for one before then is refused with
 * 400 `VALIDATION_FAILED`, naming the versions that can be used.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateConversationCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateConversationCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateConversationInput
 *   idempotencyKey: "STRING_VALUE",
 *   agentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE", // required
 *   title: "STRING_VALUE",
 * };
 * const command = new CreateConversationCommand(input);
 * const response = await client.send(command);
 * // { // CreateConversationOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
 * //   id: "STRING_VALUE", // required
 * //   agentId: "STRING_VALUE", // required
 * //   version: "STRING_VALUE", // required
 * //   title: "STRING_VALUE",
 * //   createdAt: new Date("TIMESTAMP"), // required
 * // };
 *
 * ```
 *
 * @param CreateConversationCommandInput - {@link CreateConversationCommandInput}
 * @returns {@link CreateConversationCommandOutput}
 * @see {@link CreateConversationCommandInput} for command's `input` shape.
 * @see {@link CreateConversationCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress.
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link UnprocessableContentError} (client fault)
 *  The idempotency key was already used with a different request body.
 *
 * @throws {@link ValidationError} (client fault)
 *  The request is malformed: a member is missing, the wrong type or out of range; it has a member,
 * filter or sort field the operation does not define; its cursor is not valid for this list; or it
 * asks to delete `draft` or `production`, which every agent keeps.
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
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Start a conversation with an agent's draft
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   idempotencyKey: "4f0c2b9e-8d1a-4c3b-9e6f-7a2d5b8c1e09",
 *   title: "Annual leave question",
 *   version: "draft"
 * };
 * const command = new CreateConversationCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   agentId: "GHT7YRWXPL",
 *   createdAt: "2026-11-13T01:02:03.000Z",
 *   id: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *   location: "/api/v3/conversations/0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *   title: "Annual leave question",
 *   version: "draft"
 * }
 * *\/
 * ```
 *
 * @example A version that cannot be used yet
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   version: "production"
 * };
 * const command = new CreateConversationCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @example An agent that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   agentId: "ZZZZZZZZZZ",
 *   version: "draft"
 * };
 * const command = new CreateConversationCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateConversationCommand extends command<CreateConversationCommandInput, CreateConversationCommandOutput>(
  _ep0,
  _mw0,
  "CreateConversation",
  CreateConversation$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateConversationInput;
      output: CreateConversationOutput;
    };
    sdk: {
      input: CreateConversationCommandInput;
      output: CreateConversationCommandOutput;
    };
  };
}
