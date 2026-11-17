// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetFieldInput, GetFieldOutput } from "../models/models_0";
import { GetField$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetFieldCommand}.
 */
export interface GetFieldCommandInput extends GetFieldInput {}
/**
 * @public
 *
 * The output of {@link GetFieldCommand}.
 */
export interface GetFieldCommandOutput extends GetFieldOutput, __MetadataBearer {}

/**
 * Gets one metadata field, with how much work it still needs.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetFieldCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetFieldCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetFieldInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   fieldKey: "STRING_VALUE", // required
 * };
 * const command = new GetFieldCommand(input);
 * const response = await client.send(command);
 * // { // GetFieldOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   field: { // Field
 * //     name: "STRING_VALUE", // required
 * //     description: "STRING_VALUE",
 * //     type: "text" || "list" || "date" || "number" || "boolean", // required
 * //     scope: "document" || "passage",
 * //     choices: [ // MetadataChoiceList
 * //       { // MetadataChoice
 * //         key: "STRING_VALUE", // required
 * //         value: "STRING_VALUE", // required
 * //       },
 * //     ],
 * //     partialDates: "start" || "empty",
 * //     instructions: { // FieldInstructions
 * //       howToFill: "STRING_VALUE",
 * //       whenToUse: "STRING_VALUE",
 * //     },
 * //     filterable: true || false,
 * //     givenToAgent: true || false,
 * //     visibleOnDocuments: true || false,
 * //     key: "STRING_VALUE", // required
 * //     needsWork: { // FieldWork
 * //       values: Number("long"), // required
 * //       index: Number("long"), // required
 * //       embed: Number("long"), // required
 * //       documents: Number("long"), // required
 * //     },
 * //     etag: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param GetFieldCommandInput - {@link GetFieldCommandInput}
 * @returns {@link GetFieldCommandOutput}
 * @see {@link GetFieldCommandInput} for command's `input` shape.
 * @see {@link GetFieldCommandOutput} for command's `response` shape.
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
 * @example A list field
 * ```javascript
 * //
 * const input = {
 *   fieldKey: "policyOwner",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetFieldCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"policyOwner-3"`,
 *   field: {
 *     choices: [
 *       {
 *         key: "hr",
 *         value: "Human resources"
 *       },
 *       {
 *         key: "finance",
 *         value: "Finance"
 *       }
 *     ],
 *     etag: `"policyOwner-3"`,
 *     key: "policyOwner",
 *     name: "Policy owner",
 *     needsWork: {
 *       documents: 0,
 *       embed: 0,
 *       index: 0,
 *       values: 0
 *     },
 *     type: "list"
 *   }
 * }
 * *\/
 * ```
 *
 * @example A field the knowledge base does not define
 * ```javascript
 * //
 * const input = {
 *   fieldKey: "nope",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetFieldCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetFieldCommand extends command<GetFieldCommandInput, GetFieldCommandOutput>(
  _ep0,
  _mw0,
  "GetField",
  GetField$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetFieldInput;
      output: GetFieldOutput;
    };
    sdk: {
      input: GetFieldCommandInput;
      output: GetFieldCommandOutput;
    };
  };
}
