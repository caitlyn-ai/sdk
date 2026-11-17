// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListToolsInput, ListToolsOutput } from "../models/models_0";
import { ListTools$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListToolsCommand}.
 */
export interface ListToolsCommandInput extends ListToolsInput {}
/**
 * @public
 *
 * The output of {@link ListToolsCommand}.
 */
export interface ListToolsCommandOutput extends ListToolsOutput, __MetadataBearer {}

/**
 * Lists Caitlyn's own tools, which an agent's phases can use.
 *
 * A phase names one of these tools with `tools[].name`. Tools on an MCP server are not in this list.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListToolsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListToolsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListToolsInput
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 * };
 * const command = new ListToolsCommand(input);
 * const response = await client.send(command);
 * // { // ListToolsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // ToolSummaryList // required
 * //     { // ToolSummary
 * //       name: "STRING_VALUE", // required
 * //       description: "STRING_VALUE", // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListToolsCommandInput - {@link ListToolsCommandInput}
 * @returns {@link ListToolsCommandOutput}
 * @see {@link ListToolsCommandInput} for command's `input` shape.
 * @see {@link ListToolsCommandOutput} for command's `response` shape.
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
 * @example The first tool
 * ```javascript
 * //
 * const input = {
 *   limit: 1
 * };
 * const command = new ListToolsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       description: "Searches the agent's knowledge bases and returns the passages it finds.",
 *       name: "searchKnowledgeBase"
 *     }
 *   ],
 *   nextCursor: "c1.MEUCIQDt7b"
 * }
 * *\/
 * ```
 *
 * @example A caller without permission to edit agents
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new ListToolsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListToolsCommand extends command<ListToolsCommandInput, ListToolsCommandOutput>(
  _ep0,
  _mw0,
  "ListTools",
  ListTools$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListToolsInput;
      output: ListToolsOutput;
    };
    sdk: {
      input: ListToolsCommandInput;
      output: ListToolsCommandOutput;
    };
  };
}
