// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetAgentVersionInput, GetAgentVersionOutput } from "../models/models_0";
import { GetAgentVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetAgentVersionCommand}.
 */
export interface GetAgentVersionCommandInput extends GetAgentVersionInput {}
/**
 * @public
 *
 * The output of {@link GetAgentVersionCommand}.
 */
export interface GetAgentVersionCommandOutput extends GetAgentVersionOutput, __MetadataBearer {}

/**
 * Gets one version of an agent, with its full configuration and its ETag.
 *
 * `version` is `draft`, `production` or the name of a pinned or published version. Production is
 * readable by everyone with access to the agent; the draft and pinned versions only by the people
 * and groups on the agent's version access grant, and anyone else gets 404.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetAgentVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetAgentVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetAgentVersionInput
 *   agentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE", // required
 * };
 * const command = new GetAgentVersionCommand(input);
 * const response = await client.send(command);
 * // { // GetAgentVersionOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   agentId: "STRING_VALUE", // required
 * //   name: "STRING_VALUE", // required
 * //   source: "pin" || "publish" || "migration" || "import",
 * //   basedOn: "STRING_VALUE",
 * //   matchesProduction: true || false,
 * //   createdAt: new Date("TIMESTAMP"), // required
 * //   note: "STRING_VALUE",
 * //   configuration: { // AgentConfiguration
 * //     identity: "STRING_VALUE",
 * //     instructions: "STRING_VALUE", // required
 * //     model: "STRING_VALUE",
 * //     knowledgeBases: [ // KnowledgeBaseBindingList
 * //       { // KnowledgeBaseBinding
 * //         knowledgeBaseId: "STRING_VALUE", // required
 * //         numberOfResults: Number("int"),
 * //         minimumScore: Number("float"),
 * //       },
 * //     ],
 * //     attachments: { // AttachmentSettings
 * //       enabled: true || false,
 * //       maxFiles: Number("int"),
 * //     },
 * //     contentSafety: { // ContentSafety
 * //       guardrailId: "STRING_VALUE",
 * //     },
 * //     deniedDocuments: true || false,
 * //   },
 * // };
 *
 * ```
 *
 * @param GetAgentVersionCommandInput - {@link GetAgentVersionCommandInput}
 * @returns {@link GetAgentVersionCommandOutput}
 * @see {@link GetAgentVersionCommandInput} for command's `input` shape.
 * @see {@link GetAgentVersionCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; or its cursor is not valid for this list.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Read the draft before editing it
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   version: "draft"
 * };
 * const command = new GetAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   agentId: "GHT7YRWXPL",
 *   configuration: {
 *     identity: "You are the HR assistant for Harbour Freight staff.",
 *     instructions: "Answer leave and pay questions from the HR policy knowledge base.",
 *     knowledgeBases: [
 *       {
 *         knowledgeBaseId: "KB4T7YQ2WL",
 *         minimumScore: 0.3,
 *         numberOfResults: 8
 *       }
 *     ],
 *     model: "claude-sonnet-5-5"
 *   },
 *   createdAt: "2026-11-02T03:04:05.000Z",
 *   etag: `"draft-41"`,
 *   matchesProduction: false,
 *   name: "draft"
 * }
 * *\/
 * ```
 *
 * @example A version name that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   version: "v99"
 * };
 * const command = new GetAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetAgentVersionCommand extends command<GetAgentVersionCommandInput, GetAgentVersionCommandOutput>(
  _ep0,
  _mw0,
  "GetAgentVersion",
  GetAgentVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetAgentVersionInput;
      output: GetAgentVersionOutput;
    };
    sdk: {
      input: GetAgentVersionCommandInput;
      output: GetAgentVersionCommandOutput;
    };
  };
}
