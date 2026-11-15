// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ResetDraftVersionInput, ResetDraftVersionOutput } from "../models/models_0";
import { ResetDraftVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ResetDraftVersionCommand}.
 */
export interface ResetDraftVersionCommandInput extends ResetDraftVersionInput {}
/**
 * @public
 *
 * The output of {@link ResetDraftVersionCommand}.
 */
export interface ResetDraftVersionCommandOutput extends ResetDraftVersionOutput, __MetadataBearer {}

/**
 * Resets the draft to a copy of another version; `If-Match` is required.
 *
 * The draft's configuration becomes the configuration of `from`, which is a version name or
 * `production`. Nothing else changes: the version copied from is kept, and production is
 * untouched. Returns the draft and its new ETag.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ResetDraftVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ResetDraftVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ResetDraftVersionInput
 *   agentId: "STRING_VALUE", // required
 *   ifMatch: "STRING_VALUE", // required
 *   from: "STRING_VALUE", // required
 * };
 * const command = new ResetDraftVersionCommand(input);
 * const response = await client.send(command);
 * // { // ResetDraftVersionOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   agentId: "STRING_VALUE", // required
 * //   name: "STRING_VALUE", // required
 * //   source: "pin" || "publish" || "migration" || "import",
 * //   basedOn: "STRING_VALUE",
 * //   matchesProduction: true || false,
 * //   createdAt: new Date("TIMESTAMP"), // required
 * //   publishedAt: new Date("TIMESTAMP"),
 * //   publishedBy: { // Actor
 * //     userId: "STRING_VALUE",
 * //     apiClientId: "STRING_VALUE",
 * //     displayName: "STRING_VALUE", // required
 * //   },
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
 * @param ResetDraftVersionCommandInput - {@link ResetDraftVersionCommandInput}
 * @returns {@link ResetDraftVersionCommandOutput}
 * @see {@link ResetDraftVersionCommandInput} for command's `input` shape.
 * @see {@link ResetDraftVersionCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; its cursor is not valid for this list; or it
 * asks to delete `draft` or `production`, which every agent keeps.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Start the draft again from the October release
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   from: "october-release",
 *   ifMatch: `"draft-42"`
 * };
 * const command = new ResetDraftVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   agentId: "GHT7YRWXPL",
 *   basedOn: "october-release",
 *   configuration: {
 *     instructions: "Answer leave and pay questions. Quote the policy clause you relied on.",
 *     model: "claude-sonnet-5-5"
 *   },
 *   createdAt: "2026-11-02T03:04:05.000Z",
 *   etag: `"draft-43"`,
 *   matchesProduction: false,
 *   name: "draft"
 * }
 * *\/
 * ```
 *
 * @example The draft changed since it was read
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   from: "october-release",
 *   ifMatch: `"draft-41"`
 * };
 * const command = new ResetDraftVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ResetDraftVersionCommand extends command<ResetDraftVersionCommandInput, ResetDraftVersionCommandOutput>(
  _ep0,
  _mw0,
  "ResetDraftVersion",
  ResetDraftVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ResetDraftVersionInput;
      output: ResetDraftVersionOutput;
    };
    sdk: {
      input: ResetDraftVersionCommandInput;
      output: ResetDraftVersionCommandOutput;
    };
  };
}
