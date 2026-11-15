// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListAgentVersionsInput, ListAgentVersionsOutput } from "../models/models_0";
import { ListAgentVersions$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListAgentVersionsCommand}.
 */
export interface ListAgentVersionsCommandInput extends ListAgentVersionsInput {}
/**
 * @public
 *
 * The output of {@link ListAgentVersionsCommand}.
 */
export interface ListAgentVersionsCommandOutput extends ListAgentVersionsOutput, __MetadataBearer {}

/**
 * Lists an agent's named versions in the order they were made, oldest first.
 *
 * Each entry says how the version was made and whether production currently matches it. The
 * draft and production are not entries: read them with `draft` and `production`. Needs the agent's
 * version access grant, as reading any version other than production does.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListAgentVersionsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListAgentVersionsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListAgentVersionsInput
 *   agentId: "STRING_VALUE", // required
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 * };
 * const command = new ListAgentVersionsCommand(input);
 * const response = await client.send(command);
 * // { // ListAgentVersionsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // AgentVersionSummaryList // required
 * //     { // AgentVersionSummary
 * //       name: "STRING_VALUE", // required
 * //       source: "pin" || "publish" || "migration" || "import",
 * //       basedOn: "STRING_VALUE",
 * //       matchesProduction: true || false,
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //       note: "STRING_VALUE",
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListAgentVersionsCommandInput - {@link ListAgentVersionsCommandInput}
 * @returns {@link ListAgentVersionsCommandOutput}
 * @see {@link ListAgentVersionsCommandInput} for command's `input` shape.
 * @see {@link ListAgentVersionsCommandOutput} for command's `response` shape.
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
 * @example The first two versions of an agent
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   limit: 2
 * };
 * const command = new ListAgentVersionsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       basedOn: "draft",
 *       createdAt: "2026-10-01T22:10:00.000Z",
 *       matchesProduction: false,
 *       name: "october-release",
 *       source: "publish"
 *     },
 *     {
 *       basedOn: "draft",
 *       createdAt: "2026-11-14T02:03:04.000Z",
 *       matchesProduction: true,
 *       name: "november-release",
 *       note: "Quotes the policy clause it relied on.",
 *       source: "pin"
 *     }
 *   ],
 *   nextCursor: "c1.MEUCIQBv7d"
 * }
 * *\/
 * ```
 *
 * @example An agent that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   agentId: "NOPE0000"
 * };
 * const command = new ListAgentVersionsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListAgentVersionsCommand extends command<ListAgentVersionsCommandInput, ListAgentVersionsCommandOutput>(
  _ep0,
  _mw0,
  "ListAgentVersions",
  ListAgentVersions$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListAgentVersionsInput;
      output: ListAgentVersionsOutput;
    };
    sdk: {
      input: ListAgentVersionsCommandInput;
      output: ListAgentVersionsCommandOutput;
    };
  };
}
