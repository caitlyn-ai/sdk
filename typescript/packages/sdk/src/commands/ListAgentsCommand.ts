// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListAgentsInput, ListAgentsOutput } from "../models/models_0";
import { ListAgents$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListAgentsCommand}.
 */
export interface ListAgentsCommandInput extends ListAgentsInput {}
/**
 * @public
 *
 * The output of {@link ListAgentsCommand}.
 */
export interface ListAgentsCommandOutput extends ListAgentsOutput, __MetadataBearer {}

/**
 * Lists the agents the caller may see, one page at a time.
 *
 * Each agent says which version live points at; read a version's configuration with
 * GetAgentVersion.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListAgentsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListAgentsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListAgentsInput
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 * };
 * const command = new ListAgentsCommand(input);
 * const response = await client.send(command);
 * // { // ListAgentsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // AgentList // required
 * //     { // Agent
 * //       id: "STRING_VALUE", // required
 * //       name: "STRING_VALUE", // required
 * //       description: "STRING_VALUE",
 * //       avatar: { // AgentAvatar
 * //         colour: "amber" || "sage" || "blue",
 * //         mark: { // AgentMark
 * //           icon: "leaf" || "package" || "document" || "chat" || "book" || "people",
 * //           pictureUrl: "STRING_VALUE",
 * //         },
 * //       },
 * //       liveVersion: "STRING_VALUE",
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //       updatedAt: new Date("TIMESTAMP"),
 * //       etag: "STRING_VALUE", // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListAgentsCommandInput - {@link ListAgentsCommandInput}
 * @returns {@link ListAgentsCommandOutput}
 * @see {@link ListAgentsCommandInput} for command's `input` shape.
 * @see {@link ListAgentsCommandOutput} for command's `response` shape.
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
 * @example The first agent
 * ```javascript
 * //
 * const input = {
 *   limit: 1
 * };
 * const command = new ListAgentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       avatar: {
 *         colour: "sage",
 *         mark: {
 *           icon: "leaf"
 *         }
 *       },
 *       createdAt: "2026-09-01T22:10:00.000Z",
 *       description: "Answers Harbour Freight staff's leave and pay questions.",
 *       etag: `"agent-tNdkhRpjnMZRq0KF"`,
 *       id: "GHT7YRWXPL",
 *       liveVersion: "november-release",
 *       name: "HR assistant",
 *       updatedAt: "2026-11-14T02:03:04.000Z"
 *     }
 *   ],
 *   nextCursor: "c1.MEUCIQDa4c"
 * }
 * *\/
 * ```
 *
 * @example A caller without permission to list agents
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new ListAgentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListAgentsCommand extends command<ListAgentsCommandInput, ListAgentsCommandOutput>(
  _ep0,
  _mw0,
  "ListAgents",
  ListAgents$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListAgentsInput;
      output: ListAgentsOutput;
    };
    sdk: {
      input: ListAgentsCommandInput;
      output: ListAgentsCommandOutput;
    };
  };
}
