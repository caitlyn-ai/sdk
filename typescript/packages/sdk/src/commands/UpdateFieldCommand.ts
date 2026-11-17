// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { UpdateFieldInput, UpdateFieldOutput } from "../models/models_0";
import { UpdateField$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link UpdateFieldCommand}.
 */
export interface UpdateFieldCommandInput extends UpdateFieldInput {}
/**
 * @public
 *
 * The output of {@link UpdateFieldCommand}.
 */
export interface UpdateFieldCommandOutput extends UpdateFieldOutput, __MetadataBearer {}

/**
 * Changes a metadata field's settings.
 *
 * Members that are absent stay unchanged. Saving never fills values in again by itself: run a
 * fill-in for that. The change is made to the field alone, so it never undoes a change someone made
 * to another field at the same time.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, UpdateFieldCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, UpdateFieldCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // UpdateFieldInput
 *   name: "STRING_VALUE",
 *   description: "STRING_VALUE",
 *   type: "text" || "list" || "date" || "number" || "boolean",
 *   scope: "document" || "passage",
 *   choices: [ // MetadataChoiceList
 *     { // MetadataChoice
 *       key: "STRING_VALUE", // required
 *       value: "STRING_VALUE", // required
 *     },
 *   ],
 *   partialDates: "start" || "empty",
 *   instructions: { // FieldInstructions
 *     howToFill: "STRING_VALUE",
 *     whenToUse: "STRING_VALUE",
 *   },
 *   filterable: true || false,
 *   givenToAgent: true || false,
 *   visibleOnDocuments: true || false,
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   fieldKey: "STRING_VALUE", // required
 *   ifMatch: "STRING_VALUE",
 * };
 * const command = new UpdateFieldCommand(input);
 * const response = await client.send(command);
 * // { // UpdateFieldOutput
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
 * @param UpdateFieldCommandInput - {@link UpdateFieldCommandInput}
 * @returns {@link UpdateFieldCommandOutput}
 * @see {@link UpdateFieldCommandInput} for command's `input` shape.
 * @see {@link UpdateFieldCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link PreconditionFailedError} (client fault)
 *  `If-Match` does not match the resource's current ETag: it changed since the caller read it.
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
 * @example Let searches filter on a field
 * ```javascript
 * //
 * const input = {
 *   fieldKey: "policyOwner",
 *   filterable: true,
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new UpdateFieldCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"policyOwner-4"`,
 *   field: {
 *     etag: `"policyOwner-4"`,
 *     filterable: true,
 *     key: "policyOwner",
 *     name: "Policy owner",
 *     needsWork: {
 *       documents: 412,
 *       embed: 0,
 *       index: 412,
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
 *   filterable: true,
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new UpdateFieldCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class UpdateFieldCommand extends command<UpdateFieldCommandInput, UpdateFieldCommandOutput>(
  _ep0,
  _mw0,
  "UpdateField",
  UpdateField$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: UpdateFieldInput;
      output: UpdateFieldOutput;
    };
    sdk: {
      input: UpdateFieldCommandInput;
      output: UpdateFieldCommandOutput;
    };
  };
}
