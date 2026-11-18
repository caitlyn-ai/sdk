// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateIngestionBatchInput, CreateIngestionBatchOutput } from "../models/models_0";
import { CreateIngestionBatch$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateIngestionBatchCommand}.
 */
export interface CreateIngestionBatchCommandInput extends CreateIngestionBatchInput {}
/**
 * @public
 *
 * The output of {@link CreateIngestionBatchCommand}.
 */
export interface CreateIngestionBatchCommandOutput extends CreateIngestionBatchOutput, __MetadataBearer {}

/**
 * Makes an ingestion batch for one knowledge base, and plans it unless more items will follow.
 *
 * Takes up to 10,000 items; add more with BatchCreateIngestionBatchItems while `awaitMoreItems` is
 * true. Returns 202 with the batch, and `Location` names it; wait for the plan with the SDKs'
 * `batch.planned()`. Needs the ingestion create permission and read access to the knowledge base,
 * as v2's ingestion route does; starting the batch, which hands out an upload policy, also needs the
 * files create permission. A `fetchUrl` item needs the files create permission when it is added,
 * which the server checks, because the trait cannot follow an item's member.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateIngestionBatchCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateIngestionBatchCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateIngestionBatchInput
 *   idempotencyKey: "STRING_VALUE",
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   start: "when_planned" || "manual",
 *   awaitMoreItems: true || false,
 *   policy: { // IngestionPolicy
 *     onConflict: { // ConflictRules
 *       default: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 *       pathTaken: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 *       ambiguousContent: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 *       duplicatePath: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 *       duplicateExternalKey: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 *       duplicateInBatch: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 *       changedSincePlan: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 *     },
 *     onRemove: "remove" || "ask" || "skip",
 *     onUnchanged: "skip" || "reingest",
 *     onMoved: "move" || "copy" || "skip",
 *   },
 *   scope: { // IngestionBoundary
 *     folderPath: "STRING_VALUE", // required
 *   },
 *   items: [ // IngestionItemInputList
 *     { // IngestionItemInput
 *       action: "ingest" || "remove",
 *       path: "STRING_VALUE",
 *       externalId: "STRING_VALUE",
 *       sha256: "STRING_VALUE",
 *       byteSize: Number("long"),
 *       contentType: "STRING_VALUE",
 *       fetchUrl: "STRING_VALUE",
 *       sourceUrl: "STRING_VALUE",
 *       metadata: { // DocumentMetadata
 *         "<keys>": "DOCUMENT_VALUE",
 *       },
 *       extraMetadata: { // ExtraMetadata
 *         "<keys>": "DOCUMENT_VALUE",
 *       },
 *     },
 *   ],
 *   uploadWindowSeconds: Number("int"),
 * };
 * const command = new CreateIngestionBatchCommand(input);
 * const response = await client.send(command);
 * // { // CreateIngestionBatchOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   batch: { // IngestionBatch
 * //     id: "STRING_VALUE", // required
 * //     knowledgeBaseId: "STRING_VALUE", // required
 * //     status: "draft" || "planning" || "planned" || "running" || "succeeded" || "completed_with_failures" || "failed" || "cancelled", // required
 * //     start: "when_planned" || "manual", // required
 * //     awaitMoreItems: true || false, // required
 * //     policy: { // IngestionPolicy
 * //       onConflict: { // ConflictRules
 * //         default: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         pathTaken: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         ambiguousContent: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         duplicatePath: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         duplicateExternalKey: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         duplicateInBatch: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //         changedSincePlan: "ask" || "skip" || "new_version" || "overwrite" || "fail",
 * //       },
 * //       onRemove: "remove" || "ask" || "skip",
 * //       onUnchanged: "skip" || "reingest",
 * //       onMoved: "move" || "copy" || "skip",
 * //     },
 * //     scope: { // IngestionBoundary
 * //       folderPath: "STRING_VALUE", // required
 * //     },
 * //     itemCount: Number("long"), // required
 * //     counts: { // IngestionBatchCounts
 * //       byOutcome: { // OutcomeCountMap
 * //         "<keys>": Number("long"),
 * //       },
 * //       byStatus: { // ItemStatusCountMap
 * //         "<keys>": Number("long"),
 * //       },
 * //     },
 * //     percent: Number("int"),
 * //     eta: { // Eta
 * //       seconds: { // NumberRange
 * //         low: Number("double"), // required
 * //         high: Number("double"), // required
 * //       },
 * //     },
 * //     planExpiresAt: new Date("TIMESTAMP"),
 * //     uploadsExpireAt: new Date("TIMESTAMP"),
 * //     createdBy: { // Actor
 * //       userId: "STRING_VALUE",
 * //       apiClientId: "STRING_VALUE",
 * //       displayName: "STRING_VALUE", // required
 * //     },
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     updatedAt: new Date("TIMESTAMP"), // required
 * //     startedAt: new Date("TIMESTAMP"),
 * //     endedAt: new Date("TIMESTAMP"),
 * //     failure: { // IngestionBatchFailure
 * //       code: "conflict_policy_fail" || "planning_failed" || "internal_error", // required
 * //       message: "STRING_VALUE", // required
 * //     },
 * //     uploadWindowSeconds: Number("int"),
 * //     etag: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param CreateIngestionBatchCommandInput - {@link CreateIngestionBatchCommandInput}
 * @returns {@link CreateIngestionBatchCommandOutput}
 * @see {@link CreateIngestionBatchCommandInput} for command's `input` shape.
 * @see {@link CreateIngestionBatchCommandOutput} for command's `response` shape.
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
 * @example Plan a folder of policies before uploading anything
 * ```javascript
 * //
 * const input = {
 *   idempotencyKey: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
 *   items: [
 *     {
 *       byteSize: 501337,
 *       contentType: "application/pdf",
 *       externalId: "hr/leave-policy",
 *       path: "/hr/leave-policy.pdf",
 *       sha256: "q8r3Hc5nZ1YbV0LwXk2PjT7sFm9gD4eA6uWiOyKlQhE="
 *     },
 *     {
 *       action: "remove",
 *       externalId: "hr/old-leave-policy"
 *     }
 *   ],
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   policy: {
 *     onConflict: {
 *       default: "ask",
 *       pathTaken: "skip"
 *     },
 *     onRemove: "ask"
 *   },
 *   start: "manual"
 * };
 * const command = new CreateIngestionBatchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   batch: {
 *     awaitMoreItems: false,
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     etag: `"1"`,
 *     id: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *     itemCount: 2,
 *     knowledgeBaseId: "KB4T7YQ2WL",
 *     policy: {
 *       onConflict: {
 *         default: "ask",
 *         pathTaken: "skip"
 *       },
 *       onRemove: "ask"
 *     },
 *     start: "manual",
 *     status: "planning",
 *     updatedAt: "2026-11-16T01:02:03.000Z"
 *   },
 *   etag: `"1"`,
 *   location: "/api/v3/knowledge-bases/KB4T7YQ2WL/ingestion-batches/0193a6f3-0001-7a2b-8c3d-4e5f60718293"
 * }
 * *\/
 * ```
 *
 * @example A knowledge base that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KBNOPE0000",
 *   start: "when_planned"
 * };
 * const command = new CreateIngestionBatchCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateIngestionBatchCommand extends command<CreateIngestionBatchCommandInput, CreateIngestionBatchCommandOutput>(
  _ep0,
  _mw0,
  "CreateIngestionBatch",
  CreateIngestionBatch$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateIngestionBatchInput;
      output: CreateIngestionBatchOutput;
    };
    sdk: {
      input: CreateIngestionBatchCommandInput;
      output: CreateIngestionBatchCommandOutput;
    };
  };
}
