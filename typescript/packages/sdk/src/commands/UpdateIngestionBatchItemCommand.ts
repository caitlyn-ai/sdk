// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { UpdateIngestionBatchItemInput, UpdateIngestionBatchItemOutput } from "../models/models_0";
import { UpdateIngestionBatchItem$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link UpdateIngestionBatchItemCommand}.
 */
export interface UpdateIngestionBatchItemCommandInput extends UpdateIngestionBatchItemInput {}
/**
 * @public
 *
 * The output of {@link UpdateIngestionBatchItemCommand}.
 */
export interface UpdateIngestionBatchItemCommandOutput extends UpdateIngestionBatchItemOutput, __MetadataBearer {}

/**
 * Resolves one item of a planned batch by hand.
 *
 * Only `resolution` can change, and only while the batch is `planned`; anything else is refused with
 * 409 `CONFLICT`. A resolution that does not fit the outcome (for example `move` for a `new` item) is
 * refused with 400 `VALIDATION_FAILED`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, UpdateIngestionBatchItemCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, UpdateIngestionBatchItemCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // UpdateIngestionBatchItemInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   ingestionBatchId: "STRING_VALUE", // required
 *   itemId: "STRING_VALUE", // required
 *   ifMatch: "STRING_VALUE",
 *   resolution: "add" || "new_version" || "skip" || "move" || "update_metadata" || "remove" || "overwrite" || "unresolved", // required
 * };
 * const command = new UpdateIngestionBatchItemCommand(input);
 * const response = await client.send(command);
 * // { // UpdateIngestionBatchItemOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   item: { // IngestionBatchItem
 * //     action: "ingest" || "remove",
 * //     path: "STRING_VALUE",
 * //     externalId: "STRING_VALUE",
 * //     sha256: "STRING_VALUE",
 * //     byteSize: Number("long"),
 * //     contentType: "STRING_VALUE",
 * //     fetchUrl: "STRING_VALUE",
 * //     sourceUrl: "STRING_VALUE",
 * //     metadata: { // DocumentMetadata
 * //       "<keys>": "DOCUMENT_VALUE",
 * //     },
 * //     extraMetadata: { // ExtraMetadata
 * //       "<keys>": "DOCUMENT_VALUE",
 * //     },
 * //     id: "STRING_VALUE", // required
 * //     outcome: "new" || "unchanged" || "changed" || "moved" || "in_progress" || "to_remove" || "fetch_failed" || "conflict",
 * //     reason: "path_taken" || "ambiguous_content" || "duplicate_path" || "duplicate_external_id" || "duplicate_in_batch" || "changed_since_plan" || "fetch_blocked" || "fetch_http_error" || "fetch_timeout" || "fetch_too_large" || "fetch_unsupported_type" || "fetch_too_many_redirects",
 * //     metadataChanged: true || false,
 * //     matches: [ // DocumentMatchList
 * //       { // DocumentMatch
 * //         documentId: "STRING_VALUE", // required
 * //         path: "STRING_VALUE", // required
 * //         version: Number("int"),
 * //         sha256: "STRING_VALUE",
 * //         restoresVersion: Number("int"),
 * //       },
 * //     ],
 * //     resolution: "add" || "new_version" || "skip" || "move" || "update_metadata" || "remove" || "overwrite" || "unresolved",
 * //     status: "draft" || "awaiting_upload" || "ingesting" || "indexed" || "skipped" || "moved" || "updated" || "removed" || "cancelled" || "failed", // required
 * //     objectKey: "STRING_VALUE",
 * //     documentId: "STRING_VALUE",
 * //     version: Number("int"),
 * //     failureCode: "STRING_VALUE",
 * //     failureDetail: "STRING_VALUE",
 * //     etag: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param UpdateIngestionBatchItemCommandInput - {@link UpdateIngestionBatchItemCommandInput}
 * @returns {@link UpdateIngestionBatchItemCommandOutput}
 * @see {@link UpdateIngestionBatchItemCommandInput} for command's `input` shape.
 * @see {@link UpdateIngestionBatchItemCommandOutput} for command's `response` shape.
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
 * @example Skip an item that clashed
 * ```javascript
 * //
 * const input = {
 *   ifMatch: `"2"`,
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   itemId: "item-0003",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   resolution: "skip"
 * };
 * const command = new UpdateIngestionBatchItemCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"3"`,
 *   item: {
 *     action: "ingest",
 *     etag: `"3"`,
 *     externalId: "hr/code-of-conduct",
 *     id: "item-0003",
 *     outcome: "conflict",
 *     path: "/hr/conduct.pdf",
 *     reason: "path_taken",
 *     resolution: "skip",
 *     status: "draft"
 *   }
 * }
 * *\/
 * ```
 *
 * @example The item changed since it was read
 * ```javascript
 * //
 * const input = {
 *   ifMatch: `"1"`,
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   itemId: "item-0003",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   resolution: "skip"
 * };
 * const command = new UpdateIngestionBatchItemCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class UpdateIngestionBatchItemCommand extends command<UpdateIngestionBatchItemCommandInput, UpdateIngestionBatchItemCommandOutput>(
  _ep0,
  _mw0,
  "UpdateIngestionBatchItem",
  UpdateIngestionBatchItem$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: UpdateIngestionBatchItemInput;
      output: UpdateIngestionBatchItemOutput;
    };
    sdk: {
      input: UpdateIngestionBatchItemCommandInput;
      output: UpdateIngestionBatchItemCommandOutput;
    };
  };
}
