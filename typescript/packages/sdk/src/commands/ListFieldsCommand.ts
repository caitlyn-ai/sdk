// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListFieldsInput, ListFieldsOutput } from "../models/models_0";
import { ListFields$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListFieldsCommand}.
 */
export interface ListFieldsCommandInput extends ListFieldsInput {}
/**
 * @public
 *
 * The output of {@link ListFieldsCommand}.
 */
export interface ListFieldsCommandOutput extends ListFieldsOutput, __MetadataBearer {}

/**
 * Lists a knowledge base's metadata fields, each with how much work it still needs.
 *
 * `needsWork` says how many documents still need a value, an index write or new search vectors for
 * the field; `fillIn` does that work.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListFieldsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListFieldsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListFieldsInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 * };
 * const command = new ListFieldsCommand(input);
 * const response = await client.send(command);
 * // { // ListFieldsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // FieldList // required
 * //     { // Field
 * //       name: "STRING_VALUE", // required
 * //       description: "STRING_VALUE",
 * //       type: "text" || "list" || "date" || "number" || "boolean", // required
 * //       scope: "document" || "passage",
 * //       choices: [ // MetadataChoiceList
 * //         { // MetadataChoice
 * //           key: "STRING_VALUE", // required
 * //           value: "STRING_VALUE", // required
 * //         },
 * //       ],
 * //       partialDates: "start" || "empty",
 * //       instructions: { // FieldInstructions
 * //         howToFill: "STRING_VALUE",
 * //         whenToUse: "STRING_VALUE",
 * //       },
 * //       filterable: true || false,
 * //       givenToAgent: true || false,
 * //       visibleOnDocuments: true || false,
 * //       key: "STRING_VALUE", // required
 * //       needsWork: { // FieldWork
 * //         values: Number("long"), // required
 * //         index: Number("long"), // required
 * //         embed: Number("long"), // required
 * //         documents: Number("long"), // required
 * //       },
 * //       etag: "STRING_VALUE", // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListFieldsCommandInput - {@link ListFieldsCommandInput}
 * @returns {@link ListFieldsCommandOutput}
 * @see {@link ListFieldsCommandInput} for command's `input` shape.
 * @see {@link ListFieldsCommandOutput} for command's `response` shape.
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
 * @example A knowledge base's fields
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new ListFieldsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       choices: [
 *         {
 *           key: "hr",
 *           value: "Human resources"
 *         },
 *         {
 *           key: "finance",
 *           value: "Finance"
 *         }
 *       ],
 *       etag: `"policyOwner-3"`,
 *       filterable: true,
 *       givenToAgent: true,
 *       key: "policyOwner",
 *       name: "Policy owner",
 *       needsWork: {
 *         documents: 40,
 *         embed: 0,
 *         index: 40,
 *         values: 40
 *       },
 *       type: "list"
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A knowledge base that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KBNOPE0000"
 * };
 * const command = new ListFieldsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListFieldsCommand extends command<ListFieldsCommandInput, ListFieldsCommandOutput>(
  _ep0,
  _mw0,
  "ListFields",
  ListFields$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListFieldsInput;
      output: ListFieldsOutput;
    };
    sdk: {
      input: ListFieldsCommandInput;
      output: ListFieldsCommandOutput;
    };
  };
}
