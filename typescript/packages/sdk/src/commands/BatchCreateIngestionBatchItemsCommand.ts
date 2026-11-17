// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { BatchCreateIngestionBatchItemsInput, BatchCreateIngestionBatchItemsOutput } from "../models/models_0";
import { BatchCreateIngestionBatchItems$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link BatchCreateIngestionBatchItemsCommand}.
 */
export interface BatchCreateIngestionBatchItemsCommandInput extends BatchCreateIngestionBatchItemsInput {}
/**
 * @public
 *
 * The output of {@link BatchCreateIngestionBatchItemsCommand}.
 */
export interface BatchCreateIngestionBatchItemsCommandOutput extends BatchCreateIngestionBatchItemsOutput, __MetadataBearer {}

/**
 * Adds up to 10,000 more items to a batch that is still `draft`, with a result for each.
 *
 * A batch takes at most 100,000 items, at most 1,000 of them with `fetchUrl`. The call returns 200
 * even when every item fails: `results` has one entry per item, in request order, each `created` with
 * the item, or `failed` with a problem (for example 422 `BATCH_ITEM_CONTENT_AMBIGUOUS`). One bad
 * item never refuses the rest. A batch that is not `draft` is refused with 409 `CONFLICT`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, BatchCreateIngestionBatchItemsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, BatchCreateIngestionBatchItemsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // BatchCreateIngestionBatchItemsInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   ingestionBatchId: "STRING_VALUE", // required
 *   items: [ // IngestionItemInputList // required
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
 *   last: true || false,
 * };
 * const command = new BatchCreateIngestionBatchItemsCommand(input);
 * const response = await client.send(command);
 * // { // BatchCreateIngestionBatchItemsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   results: [ // ItemCreateResultList // required
 * //     { // ItemCreateResult
 * //       index: Number("int"), // required
 * //       status: "created" || "failed", // required
 * //       item: { // IngestionBatchItem
 * //         action: "ingest" || "remove",
 * //         path: "STRING_VALUE",
 * //         externalId: "STRING_VALUE",
 * //         sha256: "STRING_VALUE",
 * //         byteSize: Number("long"),
 * //         contentType: "STRING_VALUE",
 * //         fetchUrl: "STRING_VALUE",
 * //         sourceUrl: "STRING_VALUE",
 * //         metadata: { // DocumentMetadata
 * //           "<keys>": "DOCUMENT_VALUE",
 * //         },
 * //         extraMetadata: { // ExtraMetadata
 * //           "<keys>": "DOCUMENT_VALUE",
 * //         },
 * //         id: "STRING_VALUE", // required
 * //         outcome: "new" || "unchanged" || "changed" || "moved" || "in_progress" || "to_remove" || "fetch_failed" || "conflict",
 * //         reason: "path_taken" || "ambiguous_content" || "duplicate_path" || "duplicate_external_id" || "duplicate_in_batch" || "changed_since_plan" || "fetch_blocked" || "fetch_http_error" || "fetch_timeout" || "fetch_too_large" || "fetch_unsupported_type" || "fetch_too_many_redirects",
 * //         metadataChanged: true || false,
 * //         matches: [ // DocumentMatchList
 * //           { // DocumentMatch
 * //             documentId: "STRING_VALUE", // required
 * //             path: "STRING_VALUE", // required
 * //             version: Number("int"),
 * //             sha256: "STRING_VALUE",
 * //             restoresVersion: Number("int"),
 * //           },
 * //         ],
 * //         resolution: "add" || "new_version" || "skip" || "move" || "update_metadata" || "remove" || "overwrite" || "unresolved",
 * //         status: "draft" || "awaiting_upload" || "ingesting" || "indexed" || "skipped" || "moved" || "updated" || "removed" || "cancelled" || "failed", // required
 * //         objectKey: "STRING_VALUE",
 * //         documentId: "STRING_VALUE",
 * //         version: Number("int"),
 * //         failureCode: "STRING_VALUE",
 * //         failureDetail: "STRING_VALUE",
 * //         etag: "STRING_VALUE", // required
 * //       },
 * //       code: "STRING_VALUE",
 * //       detail: "STRING_VALUE",
 * //     },
 * //   ],
 * // };
 *
 * ```
 *
 * @param BatchCreateIngestionBatchItemsCommandInput - {@link BatchCreateIngestionBatchItemsCommandInput}
 * @returns {@link BatchCreateIngestionBatchItemsCommandOutput}
 * @see {@link BatchCreateIngestionBatchItemsCommandInput} for command's `input` shape.
 * @see {@link BatchCreateIngestionBatchItemsCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress. An agent version that live points at
 * (`VERSION_IN_USE`) or that live history names (`VERSION_IN_HISTORY`) cannot be deleted. A
 * document still being ingested takes no new version (`DOCUMENT_INGESTION_IN_PROGRESS`), an
 * ingestion batch with unresolved items cannot start (`INGESTION_BATCH_UNRESOLVED`), and a document
 * an ingestion batch is working on refuses other writes (`TARGET_IN_USE`); the first and last carry
 * `Retry-After`.
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
 * @example Add two items, one of which describes its content twice
 * ```javascript
 * //
 * const input = {
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   items: [
 *     {
 *       byteSize: 482113,
 *       contentType: "application/pdf",
 *       path: "/hr/pay-policy.pdf",
 *       sha256: "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="
 *     },
 *     {
 *       byteSize: 482113,
 *       contentType: "application/pdf",
 *       fetchUrl: "https://intranet.harbourfreight.example/conduct.pdf",
 *       path: "/hr/code-of-conduct.pdf",
 *       sha256: "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="
 *     }
 *   ],
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new BatchCreateIngestionBatchItemsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   results: [
 *     {
 *       index: 0,
 *       item: {
 *         action: "ingest",
 *         etag: `"1"`,
 *         id: "item-0004",
 *         path: "/hr/pay-policy.pdf",
 *         status: "draft"
 *       },
 *       status: "created"
 *     },
 *     {
 *       code: "BATCH_ITEM_CONTENT_AMBIGUOUS",
 *       detail: "Give either sha256, byteSize and contentType, or fetchUrl, not both.",
 *       index: 1,
 *       status: "failed"
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A batch that has stopped taking items
 * ```javascript
 * //
 * const input = {
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   items:   [],
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new BatchCreateIngestionBatchItemsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class BatchCreateIngestionBatchItemsCommand extends command<BatchCreateIngestionBatchItemsCommandInput, BatchCreateIngestionBatchItemsCommandOutput>(
  _ep0,
  _mw0,
  "BatchCreateIngestionBatchItems",
  BatchCreateIngestionBatchItems$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: BatchCreateIngestionBatchItemsInput;
      output: BatchCreateIngestionBatchItemsOutput;
    };
    sdk: {
      input: BatchCreateIngestionBatchItemsCommandInput;
      output: BatchCreateIngestionBatchItemsCommandOutput;
    };
  };
}
