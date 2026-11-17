// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CompleteIngestionBatchUploadsInput, CompleteIngestionBatchUploadsOutput } from "../models/models_0";
import { CompleteIngestionBatchUploads$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CompleteIngestionBatchUploadsCommand}.
 */
export interface CompleteIngestionBatchUploadsCommandInput extends CompleteIngestionBatchUploadsInput {}
/**
 * @public
 *
 * The output of {@link CompleteIngestionBatchUploadsCommand}.
 */
export interface CompleteIngestionBatchUploadsCommandOutput extends CompleteIngestionBatchUploadsOutput, __MetadataBearer {}

/**
 * Reports that items' bytes are in place, so they can be ingested.
 *
 * Takes 1 to 100 item identifiers, each awaiting upload. For each, the server checks that the
 * uploaded object's stored SHA-256 and size match the item's, and that the caller may still write to
 * the item's folder, then starts its ingestion. Returns 200 with a result for each item, in request
 * order: `accepted`, or `failed` with `CHECKSUM_MISMATCH` (the object is deleted; upload it again),
 * `NOT_FOUND` (nothing was uploaded to the item's key), `PERMISSION_DENIED`, `UPLOAD_EXPIRED` or
 * `CONFLICT` (the item is not awaiting upload). One failed item never stops the others. The SDKs
 * always call this for you. An upload nobody reports is found by the server within about a minute,
 * while the batch has items awaiting upload, and goes through the same checks; only an item whose
 * bytes are still missing when its reservation ends fails, with `UPLOAD_EXPIRED`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CompleteIngestionBatchUploadsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CompleteIngestionBatchUploadsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CompleteIngestionBatchUploadsInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   ingestionBatchId: "STRING_VALUE", // required
 *   itemIds: [ // IngestionBatchItemIdList // required
 *     "STRING_VALUE",
 *   ],
 * };
 * const command = new CompleteIngestionBatchUploadsCommand(input);
 * const response = await client.send(command);
 * // { // CompleteIngestionBatchUploadsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   results: [ // UploadCompletionResultList // required
 * //     { // UploadCompletionResult
 * //       itemId: "STRING_VALUE", // required
 * //       status: "accepted" || "failed", // required
 * //       code: "STRING_VALUE",
 * //       detail: "STRING_VALUE",
 * //     },
 * //   ],
 * // };
 *
 * ```
 *
 * @param CompleteIngestionBatchUploadsCommandInput - {@link CompleteIngestionBatchUploadsCommandInput}
 * @returns {@link CompleteIngestionBatchUploadsCommandOutput}
 * @see {@link CompleteIngestionBatchUploadsCommandInput} for command's `input` shape.
 * @see {@link CompleteIngestionBatchUploadsCommandOutput} for command's `response` shape.
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
 * @example Two uploads, one of which arrived damaged
 * ```javascript
 * //
 * const input = {
 *   ingestionBatchId: "0193a6f3-0001-7a2b-8c3d-4e5f60718293",
 *   itemIds: [
 *     "item-0001",
 *     "item-0002"
 *   ],
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new CompleteIngestionBatchUploadsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   results: [
 *     {
 *       itemId: "item-0001",
 *       status: "accepted"
 *     },
 *     {
 *       code: "CHECKSUM_MISMATCH",
 *       detail: "The uploaded bytes do not match the item's sha256. Upload the file again.",
 *       itemId: "item-0002",
 *       status: "failed"
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
 *   itemIds: [
 *     "item-0001"
 *   ],
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new CompleteIngestionBatchUploadsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CompleteIngestionBatchUploadsCommand extends command<CompleteIngestionBatchUploadsCommandInput, CompleteIngestionBatchUploadsCommandOutput>(
  _ep0,
  _mw0,
  "CompleteIngestionBatchUploads",
  CompleteIngestionBatchUploads$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CompleteIngestionBatchUploadsInput;
      output: CompleteIngestionBatchUploadsOutput;
    };
    sdk: {
      input: CompleteIngestionBatchUploadsCommandInput;
      output: CompleteIngestionBatchUploadsCommandOutput;
    };
  };
}
