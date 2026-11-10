// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { UpdateDraftVersionInput, UpdateDraftVersionOutput } from "../models/models_0";
import { UpdateDraftVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link UpdateDraftVersionCommand}.
 */
export interface UpdateDraftVersionCommandInput extends UpdateDraftVersionInput {}
/**
 * @public
 *
 * The output of {@link UpdateDraftVersionCommand}.
 */
export interface UpdateDraftVersionCommandOutput extends UpdateDraftVersionOutput, __MetadataBearer {}

/**
 * Edits the draft with a partial update of its configuration; `If-Match` is required.
 *
 * Members that are absent stay unchanged, nested objects are merged and lists are replaced whole.
 * To return a member to its default, name it in `clear`; naming a member that is not clearable, or
 * one the same request also sets, is refused with 400 `VALIDATION_FAILED`. Returns the whole draft
 * and its new ETag.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, UpdateDraftVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, UpdateDraftVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // UpdateDraftVersionInput
 *   agentId: "STRING_VALUE", // required
 *   ifMatch: "STRING_VALUE", // required
 *   identity: "STRING_VALUE",
 *   instructions: "STRING_VALUE",
 *   model: "STRING_VALUE",
 *   knowledgeBases: [ // KnowledgeBaseBindingList
 *     { // KnowledgeBaseBinding
 *       knowledgeBaseId: "STRING_VALUE", // required
 *       numberOfResults: Number("int"),
 *       minimumScore: Number("float"),
 *     },
 *   ],
 *   attachments: { // AttachmentSettings
 *     enabled: true || false,
 *     maxFiles: Number("int"),
 *   },
 *   contentSafety: { // ContentSafety
 *     guardrailId: "STRING_VALUE",
 *   },
 *   deniedDocuments: true || false,
 *   clear: [ // ClearableDraftFieldList
 *     "identity",
 *   ],
 * };
 * const command = new UpdateDraftVersionCommand(input);
 * const response = await client.send(command);
 * // { // UpdateDraftVersionOutput
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
 * @param UpdateDraftVersionCommandInput - {@link UpdateDraftVersionCommandInput}
 * @returns {@link UpdateDraftVersionCommandOutput}
 * @see {@link UpdateDraftVersionCommandInput} for command's `input` shape.
 * @see {@link UpdateDraftVersionCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; or its cursor is not valid for this list.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Change the instructions and clear the identity
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   clear: [
 *     "identity"
 *   ],
 *   ifMatch: `"draft-41"`,
 *   instructions: "Answer leave and pay questions. Quote the policy clause you relied on."
 * };
 * const command = new UpdateDraftVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   agentId: "GHT7YRWXPL",
 *   configuration: {
 *     instructions: "Answer leave and pay questions. Quote the policy clause you relied on.",
 *     model: "claude-sonnet-5-5"
 *   },
 *   createdAt: "2026-11-02T03:04:05.000Z",
 *   etag: `"draft-42"`,
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
 *   ifMatch: `"draft-40"`,
 *   instructions: "Answer leave questions."
 * };
 * const command = new UpdateDraftVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class UpdateDraftVersionCommand extends command<UpdateDraftVersionCommandInput, UpdateDraftVersionCommandOutput>(
  _ep0,
  _mw0,
  "UpdateDraftVersion",
  UpdateDraftVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: UpdateDraftVersionInput;
      output: UpdateDraftVersionOutput;
    };
    sdk: {
      input: UpdateDraftVersionCommandInput;
      output: UpdateDraftVersionCommandOutput;
    };
  };
}
