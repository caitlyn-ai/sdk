// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { PublishAgentVersionInput, PublishAgentVersionOutput } from "../models/models_0";
import { PublishAgentVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link PublishAgentVersionCommand}.
 */
export interface PublishAgentVersionCommandInput extends PublishAgentVersionInput {}
/**
 * @public
 *
 * The output of {@link PublishAgentVersionCommand}.
 */
export interface PublishAgentVersionCommandOutput extends PublishAgentVersionOutput, __MetadataBearer {}

/**
 * Publishes a version: production becomes a copy of it.
 *
 * `version` is a version name, or `draft`. Publishing the draft first keeps a copy of it as a new
 * version named `name`, then publishes that, so production always matches a named version. The
 * version published is kept as it is; nothing is moved or deleted, and deleting it later does not
 * change production. Send production's current ETag
 * (from `GET /v3/agents/\{agentId\}/versions/production`) as `If-Match`, so two publishes cannot
 * overwrite each other; a stale ETag is refused with 412. Production before the publish is kept as
 * a production history entry (ListProductionHistoryEntries), stamped with who replaced it and
 * when; the new production carries `publishedAt` and `publishedBy`. Rolling back is publishing an
 * earlier version.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, PublishAgentVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, PublishAgentVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // PublishAgentVersionInput
 *   agentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE", // required
 *   ifMatch: "STRING_VALUE", // required
 *   name: "STRING_VALUE",
 *   note: "STRING_VALUE",
 * };
 * const command = new PublishAgentVersionCommand(input);
 * const response = await client.send(command);
 * // { // PublishAgentVersionOutput
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
 * @param PublishAgentVersionCommandInput - {@link PublishAgentVersionCommandInput}
 * @returns {@link PublishAgentVersionCommandOutput}
 * @see {@link PublishAgentVersionCommandInput} for command's `input` shape.
 * @see {@link PublishAgentVersionCommandOutput} for command's `response` shape.
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
 * @example Publish the tested draft as a new version
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   ifMatch: `"production-17"`,
 *   name: "november-release",
 *   note: "Quotes the policy clause it relied on.",
 *   version: "draft"
 * };
 * const command = new PublishAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   agentId: "GHT7YRWXPL",
 *   basedOn: "november-release",
 *   configuration: {
 *     instructions: "Answer leave and pay questions. Quote the policy clause you relied on.",
 *     model: "claude-sonnet-5-5"
 *   },
 *   createdAt: "2026-11-14T02:03:04.000Z",
 *   etag: `"production-18"`,
 *   matchesProduction: true,
 *   name: "production",
 *   note: "Quotes the policy clause it relied on.",
 *   publishedAt: "2026-11-14T02:03:04.000Z",
 *   publishedBy: {
 *     displayName: "Aroha Ngata",
 *     userId: "3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64"
 *   },
 *   source: "publish"
 * }
 * *\/
 * ```
 *
 * @example Production changed since it was read
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   ifMatch: `"production-16"`,
 *   version: "october-release"
 * };
 * const command = new PublishAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class PublishAgentVersionCommand extends command<PublishAgentVersionCommandInput, PublishAgentVersionCommandOutput>(
  _ep0,
  _mw0,
  "PublishAgentVersion",
  PublishAgentVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: PublishAgentVersionInput;
      output: PublishAgentVersionOutput;
    };
    sdk: {
      input: PublishAgentVersionCommandInput;
      output: PublishAgentVersionCommandOutput;
    };
  };
}
