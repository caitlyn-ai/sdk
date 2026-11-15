// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { PinDraftVersionInput, PinDraftVersionOutput } from "../models/models_0";
import { PinDraftVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link PinDraftVersionCommand}.
 */
export interface PinDraftVersionCommandInput extends PinDraftVersionInput {}
/**
 * @public
 *
 * The output of {@link PinDraftVersionCommand}.
 */
export interface PinDraftVersionCommandOutput extends PinDraftVersionOutput, __MetadataBearer {}

/**
 * Saves the draft as a new named version.
 *
 * The new version is pinned: it does not change production, and the draft carries on as before.
 * Send the draft's ETag as `If-Match` to pin only the draft you tested; without it, the draft is
 * pinned as it is now. Returns the new version, and `Location` names it.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, PinDraftVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, PinDraftVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // PinDraftVersionInput
 *   agentId: "STRING_VALUE", // required
 *   idempotencyKey: "STRING_VALUE",
 *   ifMatch: "STRING_VALUE",
 *   name: "STRING_VALUE", // required
 *   note: "STRING_VALUE",
 * };
 * const command = new PinDraftVersionCommand(input);
 * const response = await client.send(command);
 * // { // PinDraftVersionOutput
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
 * //   location: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param PinDraftVersionCommandInput - {@link PinDraftVersionCommandInput}
 * @returns {@link PinDraftVersionCommandOutput}
 * @see {@link PinDraftVersionCommandInput} for command's `input` shape.
 * @see {@link PinDraftVersionCommandOutput} for command's `response` shape.
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
 * @throws {@link PreconditionFailedError} (client fault)
 *  `If-Match` does not match the resource's current ETag: it changed since the caller read it.
 *
 * @throws {@link UnprocessableContentError} (client fault)
 *  The idempotency key was already used with a different request body.
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
 * @example Pin the tested draft
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   idempotencyKey: "5c1e7a2b-9d3f-4e6a-8b0c-1d2e3f405162",
 *   ifMatch: `"draft-42"`,
 *   name: "november-release",
 *   note: "Quotes the policy clause it relied on."
 * };
 * const command = new PinDraftVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   agentId: "GHT7YRWXPL",
 *   basedOn: "draft",
 *   configuration: {
 *     instructions: "Answer leave and pay questions. Quote the policy clause you relied on.",
 *     model: "claude-sonnet-5-5"
 *   },
 *   createdAt: "2026-11-02T03:04:05.000Z",
 *   etag: `"november-release-1"`,
 *   location: "/api/v3/agents/GHT7YRWXPL/versions/november-release",
 *   matchesProduction: false,
 *   name: "november-release",
 *   note: "Quotes the policy clause it relied on.",
 *   source: "pin"
 * }
 * *\/
 * ```
 *
 * @example A version name the agent already uses
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   name: "october-release"
 * };
 * const command = new PinDraftVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class PinDraftVersionCommand extends command<PinDraftVersionCommandInput, PinDraftVersionCommandOutput>(
  _ep0,
  _mw0,
  "PinDraftVersion",
  PinDraftVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: PinDraftVersionInput;
      output: PinDraftVersionOutput;
    };
    sdk: {
      input: PinDraftVersionCommandInput;
      output: PinDraftVersionCommandOutput;
    };
  };
}
