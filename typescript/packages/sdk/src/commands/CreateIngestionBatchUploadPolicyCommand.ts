// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateIngestionBatchUploadPolicyInput, CreateIngestionBatchUploadPolicyOutput } from "../models/models_0";
import { CreateIngestionBatchUploadPolicy$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateIngestionBatchUploadPolicyCommand}.
 */
export interface CreateIngestionBatchUploadPolicyCommandInput extends CreateIngestionBatchUploadPolicyInput {}
/**
 * @public
 *
 * The output of {@link CreateIngestionBatchUploadPolicyCommand}.
 */
export interface CreateIngestionBatchUploadPolicyCommandOutput extends CreateIngestionBatchUploadPolicyOutput, __MetadataBearer {}

/**
 * Renews a running batch's upload policy before it expires.
 *
 * Returns a new policy for the same key prefix while the batch is `running` and has items awaiting
 * upload; anything else is refused with 409 `CONFLICT`. Each renewal also extends how long the
 * batch's new documents stay reserved. A renewed policy lasts the batch's `uploadWindowSeconds`, as the
 * first did. The SDKs renew when less than 5 minutes, or half the policy's lifetime when that is
 * shorter, are left.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateIngestionBatchUploadPolicyCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateIngestionBatchUploadPolicyCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateIngestionBatchUploadPolicyInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   ingestionBatchId: "STRING_VALUE", // required
 *   idempotencyKey: "STRING_VALUE",
 * };
 * const command = new CreateIngestionBatchUploadPolicyCommand(input);
 * const response = await client.send(command);
 * // { // CreateIngestionBatchUploadPolicyOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
 * //   uploadPolicy: { // UploadPolicy
 * //     uploadUrl: "STRING_VALUE", // required
 * //     formFields: { // FormFieldMap // required
 * //       "<keys>": "STRING_VALUE",
 * //     },
 * //     keyPrefix: "STRING_VALUE", // required
 * //     maxByteSize: Number("long"), // required
 * //     expiresAt: new Date("TIMESTAMP"), // required
 * //   },
 * // };
 *
 * ```
 *
 * @param CreateIngestionBatchUploadPolicyCommandInput - {@link CreateIngestionBatchUploadPolicyCommandInput}
 * @returns {@link CreateIngestionBatchUploadPolicyCommandOutput}
 * @see {@link CreateIngestionBatchUploadPolicyCommandInput} for command's `input` shape.
 * @see {@link CreateIngestionBatchUploadPolicyCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress. An agent version that live points at
 * (`VERSION_IN_USE`) or that live history names (`VERSION_IN_HISTORY`) cannot be deleted. A
 * document still being ingested takes no new version (`DOCUMENT_INGESTION_IN_PROGRESS`), and an
 * ingestion batch with unresolved items cannot start (`INGESTION_BATCH_UNRESOLVED`).
 * `TARGET_IN_USE` refuses a write to a path an ingestion batch has reserved for a new document
 * (CreateDocument, or UpdateDocument renaming or moving a document onto it) while the batch holds
 * the path; once the batch's reservation has lapsed, the path is free and the write goes ahead. It
 * is also an ingestion batch item's failure when the document its plan found changed, or something
 * else took it, before the batch could act on it. `DOCUMENT_INGESTION_IN_PROGRESS` and
 * `TARGET_IN_USE` answers carry `Retry-After`: for `TARGET_IN_USE`, the seconds left on the batch's
 * reservation. A document whose versions are not numbered yet cannot have one deleted by number
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
 * @example Renew the upload policy
 * ```javascript
 * //
 * const input = {
 *   idempotencyKey: "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e",
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new CreateIngestionBatchUploadPolicyCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   location: "/api/v3/knowledge-bases/KB4T7YQ2WL/ingestion-batches/0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   uploadPolicy: {
 *     expiresAt: "2026-11-16T02:00:00.000Z",
 *     formFields: {
 *       policy: "eyJleHBpcmF0aW9uIjoi",
 *       x-amz-signature: "9a2e"
 *     },
 *     keyPrefix: "batches/0193a6f3-0001-7a2b-8c3d-4e5f60718293/",
 *     maxByteSize: 2147483648,
 *     uploadUrl: "https://uploads.example.com/"
 *   }
 * }
 * *\/
 * ```
 *
 * @example A batch with nothing left to upload
 * ```javascript
 * //
 * const input = {
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new CreateIngestionBatchUploadPolicyCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateIngestionBatchUploadPolicyCommand extends command<CreateIngestionBatchUploadPolicyCommandInput, CreateIngestionBatchUploadPolicyCommandOutput>(
  _ep0,
  _mw0,
  "CreateIngestionBatchUploadPolicy",
  CreateIngestionBatchUploadPolicy$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateIngestionBatchUploadPolicyInput;
      output: CreateIngestionBatchUploadPolicyOutput;
    };
    sdk: {
      input: CreateIngestionBatchUploadPolicyCommandInput;
      output: CreateIngestionBatchUploadPolicyCommandOutput;
    };
  };
}
