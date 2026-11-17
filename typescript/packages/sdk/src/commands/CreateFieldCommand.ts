// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateFieldInput, CreateFieldOutput } from "../models/models_0";
import { CreateField$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateFieldCommand}.
 */
export interface CreateFieldCommandInput extends CreateFieldInput {}
/**
 * @public
 *
 * The output of {@link CreateFieldCommand}.
 */
export interface CreateFieldCommandOutput extends CreateFieldOutput, __MetadataBearer {}

/**
 * Adds a metadata field to a knowledge base.
 *
 * Existing documents have no value for it until a fill-in fills them (`kb.fields.fillIn([key])`).
 * A key the knowledge base already defines is refused with 409 `ALREADY_EXISTS`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateFieldCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateFieldCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateFieldInput
 *   name: "STRING_VALUE", // required
 *   description: "STRING_VALUE",
 *   type: "text" || "list" || "date" || "number" || "boolean", // required
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
 *   idempotencyKey: "STRING_VALUE",
 *   key: "STRING_VALUE", // required
 * };
 * const command = new CreateFieldCommand(input);
 * const response = await client.send(command);
 * // { // CreateFieldOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
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
 * @param CreateFieldCommandInput - {@link CreateFieldCommandInput}
 * @returns {@link CreateFieldCommandOutput}
 * @see {@link CreateFieldCommandInput} for command's `input` shape.
 * @see {@link CreateFieldCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress. An agent version that live points at
 * (`VERSION_IN_USE`) or that live history names (`VERSION_IN_HISTORY`) cannot be deleted. A
 * document still being ingested takes no new version (`DOCUMENT_INGESTION_IN_PROGRESS`), an
 * ingestion batch with unresolved items cannot start (`INGESTION_BATCH_UNRESOLVED`), and a document
 * an ingestion batch is working on refuses other writes (`TARGET_IN_USE`); the first and last carry
 * `Retry-After`. A document whose versions are not numbered yet cannot have one deleted by number
 * (`VERSIONS_NOT_NUMBERED`).
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link UnprocessableContentError} (client fault)
 *  The idempotency key was already used with a different request body; supplied metadata does not
 * fit the knowledge base's field definitions or limits (`METADATA_FIELD_UNDEFINED`,
 * `METADATA_VALUE_INVALID`, `METADATA_FIELD_PASSAGE_SCOPED`, `METADATA_LIMIT_EXCEEDED`), with one
 * entry per field in `errors`; an ingestion batch item gives both or neither of its content's
 * description and a `fetchUrl` (`BATCH_ITEM_CONTENT_AMBIGUOUS`); or the document guardrail refused
 * a file (`CONTENT_REJECTED`).
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
 * @example Add a policy owner field
 * ```javascript
 * //
 * const input = {
 *   choices: [
 *     {
 *       key: "hr",
 *       value: "Human resources"
 *     },
 *     {
 *       key: "finance",
 *       value: "Finance"
 *     }
 *   ],
 *   filterable: true,
 *   idempotencyKey: "8e9fa0b1-c2d3-4e4f-8a5b-6c7d8e9fa0b1",
 *   key: "policyOwner",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   name: "Policy owner",
 *   type: "list"
 * };
 * const command = new CreateFieldCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"policyOwner-1"`,
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
 *     etag: `"policyOwner-1"`,
 *     filterable: true,
 *     key: "policyOwner",
 *     name: "Policy owner",
 *     needsWork: {
 *       documents: 412,
 *       embed: 0,
 *       index: 412,
 *       values: 412
 *     },
 *     type: "list"
 *   },
 *   location: "/api/v3/knowledge-bases/KB4T7YQ2WL/fields/policyOwner"
 * }
 * *\/
 * ```
 *
 * @example A key the knowledge base already defines
 * ```javascript
 * //
 * const input = {
 *   key: "policyOwner",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   name: "Owner",
 *   type: "text"
 * };
 * const command = new CreateFieldCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateFieldCommand extends command<CreateFieldCommandInput, CreateFieldCommandOutput>(
  _ep0,
  _mw0,
  "CreateField",
  CreateField$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateFieldInput;
      output: CreateFieldOutput;
    };
    sdk: {
      input: CreateFieldCommandInput;
      output: CreateFieldCommandOutput;
    };
  };
}
