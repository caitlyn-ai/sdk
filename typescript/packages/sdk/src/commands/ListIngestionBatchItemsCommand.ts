// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListIngestionBatchItemsInput, ListIngestionBatchItemsOutput } from "../models/models_0";
import { ListIngestionBatchItems$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListIngestionBatchItemsCommand}.
 */
export interface ListIngestionBatchItemsCommandInput extends ListIngestionBatchItemsInput {}
/**
 * @public
 *
 * The output of {@link ListIngestionBatchItemsCommand}.
 */
export interface ListIngestionBatchItemsCommandOutput extends ListIngestionBatchItemsOutput, __MetadataBearer {}

/**
 * Lists a batch's items, in the order they were added.
 *
 * Filter by action, outcome, status or resolution: for example `filter[status][eq]=awaiting_upload`
 * for the items to upload after Start, or `filter[resolution][eq]=unresolved` for those that need a
 * decision.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListIngestionBatchItemsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListIngestionBatchItemsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListIngestionBatchItemsInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   ingestionBatchId: "STRING_VALUE", // required
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 *   action: "ingest" || "remove",
 *   outcome: "new" || "unchanged" || "changed" || "moved" || "in_progress" || "to_remove" || "fetch_failed" || "conflict",
 *   status: "draft" || "awaiting_upload" || "ingesting" || "indexed" || "skipped" || "moved" || "updated" || "removed" || "cancelled" || "failed",
 *   resolution: "add" || "new_version" || "skip" || "move" || "update_metadata" || "remove" || "overwrite" || "unresolved",
 * };
 * const command = new ListIngestionBatchItemsCommand(input);
 * const response = await client.send(command);
 * // { // ListIngestionBatchItemsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // IngestionBatchItemList // required
 * //     { // IngestionBatchItem
 * //       action: "ingest" || "remove",
 * //       path: "STRING_VALUE",
 * //       externalId: "STRING_VALUE",
 * //       sha256: "STRING_VALUE",
 * //       byteSize: Number("long"),
 * //       contentType: "STRING_VALUE",
 * //       fetchUrl: "STRING_VALUE",
 * //       sourceUrl: "STRING_VALUE",
 * //       metadata: { // DocumentMetadata
 * //         "<keys>": "DOCUMENT_VALUE",
 * //       },
 * //       extraMetadata: { // ExtraMetadata
 * //         "<keys>": "DOCUMENT_VALUE",
 * //       },
 * //       id: "STRING_VALUE", // required
 * //       outcome: "new" || "unchanged" || "changed" || "moved" || "in_progress" || "to_remove" || "fetch_failed" || "conflict",
 * //       reason: "path_taken" || "ambiguous_content" || "duplicate_path" || "duplicate_external_id" || "duplicate_in_batch" || "changed_since_plan" || "fetch_blocked" || "fetch_http_error" || "fetch_timeout" || "fetch_too_large" || "fetch_unsupported_type" || "fetch_too_many_redirects",
 * //       metadataChanged: true || false,
 * //       matches: [ // DocumentMatchList
 * //         { // DocumentMatch
 * //           documentId: "STRING_VALUE", // required
 * //           path: "STRING_VALUE", // required
 * //           version: Number("int"),
 * //           sha256: "STRING_VALUE",
 * //           restoresVersion: Number("int"),
 * //         },
 * //       ],
 * //       resolution: "add" || "new_version" || "skip" || "move" || "update_metadata" || "remove" || "overwrite" || "unresolved",
 * //       status: "draft" || "awaiting_upload" || "ingesting" || "indexed" || "skipped" || "moved" || "updated" || "removed" || "cancelled" || "failed", // required
 * //       objectKey: "STRING_VALUE",
 * //       documentId: "STRING_VALUE",
 * //       version: Number("int"),
 * //       failureCode: "STRING_VALUE",
 * //       failureDetail: "STRING_VALUE",
 * //       etag: "STRING_VALUE", // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListIngestionBatchItemsCommandInput - {@link ListIngestionBatchItemsCommandInput}
 * @returns {@link ListIngestionBatchItemsCommandOutput}
 * @see {@link ListIngestionBatchItemsCommandInput} for command's `input` shape.
 * @see {@link ListIngestionBatchItemsCommandOutput} for command's `response` shape.
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
 * @example The items awaiting upload
 * ```javascript
 * //
 * const input = {
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   status: "awaiting_upload"
 * };
 * const command = new ListIngestionBatchItemsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       action: "ingest",
 *       byteSize: 501337,
 *       contentType: "application/pdf",
 *       documentId: "doc-3b7f9e21",
 *       etag: `"3"`,
 *       id: "item-0001",
 *       matches: [
 *         {
 *           documentId: "doc-3b7f9e21",
 *           path: "/hr/leave-policy.pdf",
 *           sha256: "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=",
 *           version: 2
 *         }
 *       ],
 *       objectKey: "batches/0193a6f3-0001-7a2b-8c3d-4e5f60718293/q8r3Hc5nZ1YbV0LwXk2PjT7sFm9gD4eA6uWiOyKlQhE.pdf",
 *       outcome: "changed",
 *       path: "/hr/leave-policy.pdf",
 *       resolution: "new_version",
 *       sha256: "q8r3Hc5nZ1YbV0LwXk2PjT7sFm9gD4eA6uWiOyKlQhE=",
 *       status: "awaiting_upload"
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A batch that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   ingestionBatchId: "0193a6f3-0000-7000-8000-000000000000",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new ListIngestionBatchItemsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListIngestionBatchItemsCommand extends command<ListIngestionBatchItemsCommandInput, ListIngestionBatchItemsCommandOutput>(
  _ep0,
  _mw0,
  "ListIngestionBatchItems",
  ListIngestionBatchItems$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListIngestionBatchItemsInput;
      output: ListIngestionBatchItemsOutput;
    };
    sdk: {
      input: ListIngestionBatchItemsCommandInput;
      output: ListIngestionBatchItemsCommandOutput;
    };
  };
}
