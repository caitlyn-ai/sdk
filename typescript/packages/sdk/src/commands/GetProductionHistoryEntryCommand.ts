// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetProductionHistoryEntryInput, GetProductionHistoryEntryOutput } from "../models/models_0";
import { GetProductionHistoryEntry$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetProductionHistoryEntryCommand}.
 */
export interface GetProductionHistoryEntryCommandInput extends GetProductionHistoryEntryInput {}
/**
 * @public
 *
 * The output of {@link GetProductionHistoryEntryCommand}.
 */
export interface GetProductionHistoryEntryCommandOutput extends GetProductionHistoryEntryOutput, __MetadataBearer {}

/**
 * Gets one production history entry, with the full configuration production had.
 *
 * The entry is a copy: it reads the same whether or not the version it came from still exists.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetProductionHistoryEntryCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetProductionHistoryEntryCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetProductionHistoryEntryInput
 *   agentId: "STRING_VALUE", // required
 *   historyEntryId: "STRING_VALUE", // required
 * };
 * const command = new GetProductionHistoryEntryCommand(input);
 * const response = await client.send(command);
 * // { // GetProductionHistoryEntryOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   id: "STRING_VALUE", // required
 * //   agentId: "STRING_VALUE", // required
 * //   versionName: "STRING_VALUE",
 * //   publishedAt: new Date("TIMESTAMP"), // required
 * //   publishedBy: { // Actor
 * //     userId: "STRING_VALUE",
 * //     apiClientId: "STRING_VALUE",
 * //     displayName: "STRING_VALUE", // required
 * //   },
 * //   unpublishedAt: new Date("TIMESTAMP"), // required
 * //   unpublishedBy: {
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
 * @param GetProductionHistoryEntryCommandInput - {@link GetProductionHistoryEntryCommandInput}
 * @returns {@link GetProductionHistoryEntryCommandOutput}
 * @see {@link GetProductionHistoryEntryCommandInput} for command's `input` shape.
 * @see {@link GetProductionHistoryEntryCommandOutput} for command's `response` shape.
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
 * @example Production as it was in October
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   historyEntryId: "0193a6f4-5a6b-7c8d-9e0f-102132435465"
 * };
 * const command = new GetProductionHistoryEntryCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   agentId: "GHT7YRWXPL",
 *   configuration: {
 *     instructions: "Answer leave and pay questions from the HR policy knowledge base.",
 *     model: "claude-sonnet-5-5"
 *   },
 *   id: "0193a6f4-5a6b-7c8d-9e0f-102132435465",
 *   publishedAt: "2026-10-01T22:10:00.000Z",
 *   publishedBy: {
 *     displayName: "Aroha Ngata",
 *     userId: "3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64"
 *   },
 *   unpublishedAt: "2026-11-14T02:03:04.000Z",
 *   unpublishedBy: {
 *     apiClientId: "cl_7Qm2xR9vK4",
 *     displayName: "Release pipeline"
 *   },
 *   versionName: "october-release"
 * }
 * *\/
 * ```
 *
 * @example An entry that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   historyEntryId: "0193a6f4-0000-7000-8000-000000000000"
 * };
 * const command = new GetProductionHistoryEntryCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetProductionHistoryEntryCommand extends command<GetProductionHistoryEntryCommandInput, GetProductionHistoryEntryCommandOutput>(
  _ep0,
  _mw0,
  "GetProductionHistoryEntry",
  GetProductionHistoryEntry$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetProductionHistoryEntryInput;
      output: GetProductionHistoryEntryOutput;
    };
    sdk: {
      input: GetProductionHistoryEntryCommandInput;
      output: GetProductionHistoryEntryCommandOutput;
    };
  };
}
