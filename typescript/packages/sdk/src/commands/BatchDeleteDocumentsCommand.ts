// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { BatchDeleteDocumentsInput, BatchDeleteDocumentsOutput } from "../models/models_0";
import { BatchDeleteDocuments$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link BatchDeleteDocumentsCommand}.
 */
export interface BatchDeleteDocumentsCommandInput extends BatchDeleteDocumentsInput {}
/**
 * @public
 *
 * The output of {@link BatchDeleteDocumentsCommand}.
 */
export interface BatchDeleteDocumentsCommandOutput extends BatchDeleteDocumentsOutput, __MetadataBearer {}

/**
 * Deletes up to 100 documents in one call, with a result for each.
 *
 * Each document is deleted as DeleteDocument deletes one. The call returns 200 even when every
 * item fails: `results` has one entry per identifier, always in request order, each either
 * `accepted` (the document is now `deleting`, or already was) or `failed` with a code: `NOT_FOUND`
 * for a document that is gone or that the caller may not see, and `CONFLICT` for a document still
 * being processed (`pending` or `processing`), which cannot be deleted until it is `indexed`,
 * `partially_indexed` or `failed`. One failed item never stops the others. More than 100 identifiers, none, or the same identifier twice is refused with 400
 * `VALIDATION_FAILED` for the whole call. Safe to repeat: a repeat gives the same results, apart
 * from `NOT_FOUND` for documents that finished deleting in between.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, BatchDeleteDocumentsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, BatchDeleteDocumentsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // BatchDeleteDocumentsInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentIds: [ // DocumentIdList // required
 *     "STRING_VALUE",
 *   ],
 * };
 * const command = new BatchDeleteDocumentsCommand(input);
 * const response = await client.send(command);
 * // { // BatchDeleteDocumentsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   results: [ // DocumentDeleteResultList // required
 * //     { // DocumentDeleteResult
 * //       documentId: "STRING_VALUE", // required
 * //       status: "accepted" || "failed", // required
 * //       code: "STRING_VALUE",
 * //       detail: "STRING_VALUE",
 * //     },
 * //   ],
 * // };
 *
 * ```
 *
 * @param BatchDeleteDocumentsCommandInput - {@link BatchDeleteDocumentsCommandInput}
 * @returns {@link BatchDeleteDocumentsCommandOutput}
 * @see {@link BatchDeleteDocumentsCommandInput} for command's `input` shape.
 * @see {@link BatchDeleteDocumentsCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; its cursor is not valid for this list; or it
 * asks to delete `draft` or `production`, which every agent keeps.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Delete two documents, one of which is already gone
 * ```javascript
 * //
 * const input = {
 *   documentIds: [
 *     "doc-3b7f9e21",
 *     "doc-00000000"
 *   ],
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new BatchDeleteDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   results: [
 *     {
 *       documentId: "doc-3b7f9e21",
 *       status: "accepted"
 *     },
 *     {
 *       code: "NOT_FOUND",
 *       detail: "No document doc-00000000 in knowledge base KB4T7YQ2WL.",
 *       documentId: "doc-00000000",
 *       status: "failed"
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example Delete two documents, one of which is still being processed
 * ```javascript
 * //
 * const input = {
 *   documentIds: [
 *     "doc-3b7f9e21",
 *     "doc-7c2d4e18"
 *   ],
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new BatchDeleteDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   results: [
 *     {
 *       documentId: "doc-3b7f9e21",
 *       status: "accepted"
 *     },
 *     {
 *       code: "CONFLICT",
 *       detail: "Document doc-7c2d4e18 is still being processed and cannot be deleted yet. Wait until it is indexed, partially_indexed or failed, then delete it.",
 *       documentId: "doc-7c2d4e18",
 *       status: "failed"
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
 *   documentIds: [
 *     "doc-3b7f9e21"
 *   ],
 *   knowledgeBaseId: "KBNOPE0000"
 * };
 * const command = new BatchDeleteDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class BatchDeleteDocumentsCommand extends command<BatchDeleteDocumentsCommandInput, BatchDeleteDocumentsCommandOutput>(
  _ep0,
  _mw0,
  "BatchDeleteDocuments",
  BatchDeleteDocuments$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: BatchDeleteDocumentsInput;
      output: BatchDeleteDocumentsOutput;
    };
    sdk: {
      input: BatchDeleteDocumentsCommandInput;
      output: BatchDeleteDocumentsCommandOutput;
    };
  };
}
