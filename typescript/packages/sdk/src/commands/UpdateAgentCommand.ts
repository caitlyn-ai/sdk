// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { UpdateAgentInput, UpdateAgentOutput } from "../models/models_0";
import { UpdateAgent$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link UpdateAgentCommand}.
 */
export interface UpdateAgentCommandInput extends UpdateAgentInput {}
/**
 * @public
 *
 * The output of {@link UpdateAgentCommand}.
 */
export interface UpdateAgentCommandOutput extends UpdateAgentOutput, __MetadataBearer {}

/**
 * Changes an agent's name, description or avatar; `If-Match` is required.
 *
 * These belong to the agent, not to its versions, so the change shows at once everywhere and makes
 * no new version. Members that are absent stay unchanged; name `description` or `avatar` in `clear`
 * to remove it.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, UpdateAgentCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, UpdateAgentCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // UpdateAgentInput
 *   agentId: "STRING_VALUE", // required
 *   ifMatch: "STRING_VALUE", // required
 *   name: "STRING_VALUE",
 *   description: "STRING_VALUE",
 *   avatar: { // AgentAvatarInput
 *     colour: "amber" || "sage" || "blue",
 *     mark: { // AgentMarkInput
 *       icon: "leaf" || "package" || "document" || "chat" || "book" || "people",
 *       pictureUploadId: "STRING_VALUE",
 *     },
 *   },
 *   clear: [ // ClearableAgentFieldList
 *     "description" || "avatar",
 *   ],
 * };
 * const command = new UpdateAgentCommand(input);
 * const response = await client.send(command);
 * // { // UpdateAgentOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   agent: { // Agent
 * //     id: "STRING_VALUE", // required
 * //     name: "STRING_VALUE", // required
 * //     description: "STRING_VALUE",
 * //     avatar: { // AgentAvatar
 * //       colour: "amber" || "sage" || "blue",
 * //       mark: { // AgentMark
 * //         icon: "leaf" || "package" || "document" || "chat" || "book" || "people",
 * //         pictureUrl: "STRING_VALUE",
 * //       },
 * //     },
 * //     liveVersion: "STRING_VALUE",
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     updatedAt: new Date("TIMESTAMP"),
 * //     etag: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param UpdateAgentCommandInput - {@link UpdateAgentCommandInput}
 * @returns {@link UpdateAgentCommandOutput}
 * @see {@link UpdateAgentCommandInput} for command's `input` shape.
 * @see {@link UpdateAgentCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link PreconditionFailedError} (client fault)
 *  `If-Match` does not match the resource's current ETag: it changed since the caller read it.
 *
 * @throws {@link PreconditionRequiredError} (client fault)
 *  The update sent no `If-Match` header; read the resource and send its ETag.
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
 * @example Rename an agent
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   ifMatch: `"agent-tNdkhRpjnMZRq0KF"`,
 *   name: "People and pay assistant"
 * };
 * const command = new UpdateAgentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   agent: {
 *     avatar: {
 *       colour: "sage",
 *       mark: {
 *         icon: "leaf"
 *       }
 *     },
 *     createdAt: "2026-09-01T22:10:00.000Z",
 *     description: "Answers Harbour Freight staff's leave and pay questions.",
 *     etag: `"agent-MPiRWaQqs41HRa9n"`,
 *     id: "GHT7YRWXPL",
 *     liveVersion: "november-release",
 *     name: "People and pay assistant",
 *     updatedAt: "2026-11-16T01:02:03.000Z"
 *   },
 *   etag: `"agent-MPiRWaQqs41HRa9n"`
 * }
 * *\/
 * ```
 *
 * @example The agent changed since it was read
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   ifMatch: `"agent-w1RKoViolBeEPUWz"`,
 *   name: "People and pay assistant"
 * };
 * const command = new UpdateAgentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class UpdateAgentCommand extends command<UpdateAgentCommandInput, UpdateAgentCommandOutput>(
  _ep0,
  _mw0,
  "UpdateAgent",
  UpdateAgent$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: UpdateAgentInput;
      output: UpdateAgentOutput;
    };
    sdk: {
      input: UpdateAgentCommandInput;
      output: UpdateAgentCommandOutput;
    };
  };
}
