// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CompareAgentVersionsInput, CompareAgentVersionsOutput } from "../models/models_0";
import { CompareAgentVersions$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CompareAgentVersionsCommand}.
 */
export interface CompareAgentVersionsCommandInput extends CompareAgentVersionsInput {}
/**
 * @public
 *
 * The output of {@link CompareAgentVersionsCommand}.
 */
export interface CompareAgentVersionsCommandOutput extends CompareAgentVersionsOutput, __MetadataBearer {}

/**
 * Compares two versions of an agent, member by member.
 *
 * Returns one change per member that differs, from `version` to `with`, each with its value before
 * and after; `before` is absent for a member `with` added, and `after` for one it removed. Lists are
 * compared by their items' keys, so a path reads `workflow.phases[intake].transitions`. Both versions
 * need the same access as reading them.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CompareAgentVersionsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CompareAgentVersionsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CompareAgentVersionsInput
 *   agentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE", // required
 *   withVersion: "STRING_VALUE", // required
 * };
 * const command = new CompareAgentVersionsCommand(input);
 * const response = await client.send(command);
 * // { // CompareAgentVersionsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   changes: [ // AgentVersionChangeList // required
 * //     { // AgentVersionChange
 * //       path: "STRING_VALUE", // required
 * //       before: "DOCUMENT_VALUE",
 * //       after: "DOCUMENT_VALUE",
 * //     },
 * //   ],
 * // };
 *
 * ```
 *
 * @param CompareAgentVersionsCommandInput - {@link CompareAgentVersionsCommandInput}
 * @returns {@link CompareAgentVersionsCommandOutput}
 * @see {@link CompareAgentVersionsCommandInput} for command's `input` shape.
 * @see {@link CompareAgentVersionsCommandOutput} for command's `response` shape.
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
 * @example What the draft changes from live
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   version: "live",
 *   withVersion: "draft"
 * };
 * const command = new CompareAgentVersionsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   changes: [
 *     {
 *       after: "Answer leave and pay questions. Quote the policy clause you relied on.",
 *       before: "Answer leave and pay questions from the HR policy knowledge base.",
 *       path: "guidance.instructions"
 *     },
 *     {
 *       after: {
 *         knowledgeBaseId: "KB9Q3ZR7MN"
 *       },
 *       path: "knowledgeBases[KB9Q3ZR7MN]"
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A version that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   version: "live",
 *   withVersion: "v99"
 * };
 * const command = new CompareAgentVersionsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CompareAgentVersionsCommand extends command<CompareAgentVersionsCommandInput, CompareAgentVersionsCommandOutput>(
  _ep0,
  _mw0,
  "CompareAgentVersions",
  CompareAgentVersions$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CompareAgentVersionsInput;
      output: CompareAgentVersionsOutput;
    };
    sdk: {
      input: CompareAgentVersionsCommandInput;
      output: CompareAgentVersionsCommandOutput;
    };
  };
}
