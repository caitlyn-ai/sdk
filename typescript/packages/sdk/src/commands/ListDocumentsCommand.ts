// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListDocumentsInput, ListDocumentsOutput } from "../models/models_0";
import { ListDocuments$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListDocumentsCommand}.
 */
export interface ListDocumentsCommandInput extends ListDocumentsInput {}
/**
 * @public
 *
 * The output of {@link ListDocumentsCommand}.
 */
export interface ListDocumentsCommandOutput extends ListDocumentsOutput, __MetadataBearer {}

/**
 * Lists the documents in a knowledge base, one page at a time.
 *
 * Documents are returned in a stable order that does not change between pages. Filters combine
 * with AND. Unlike v2, an unknown filter is refused with 400 `UNKNOWN_FILTER` instead of being
 * ignored, and the list can be sorted by `name`, `updatedAt` (when the document last changed) and
 * `byteSize` on the server; v2 sorts on the client only.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListDocumentsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListDocumentsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListDocumentsInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 *   sort: "STRING_VALUE",
 *   folder: "STRING_VALUE",
 *   status: "pending" || "processing" || "indexed" || "partially_indexed" || "failed" || "deleting",
 *   namePrefix: "STRING_VALUE",
 * };
 * const command = new ListDocumentsCommand(input);
 * const response = await client.send(command);
 * // { // ListDocumentsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // DocumentList // required
 * //     { // Document
 * //       id: "STRING_VALUE", // required
 * //       knowledgeBaseId: "STRING_VALUE", // required
 * //       name: "STRING_VALUE", // required
 * //       folder: "STRING_VALUE", // required
 * //       status: "pending" || "processing" || "indexed" || "partially_indexed" || "failed" || "deleting", // required
 * //       stage: "STRING_VALUE",
 * //       contentType: "STRING_VALUE",
 * //       byteSize: Number("long"),
 * //       sha256: "STRING_VALUE",
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //       updatedAt: new Date("TIMESTAMP"), // required
 * //       partialFailures: [ // PartialFailureList
 * //         { // PartialFailure
 * //           targetId: "STRING_VALUE",
 * //           code: "STRING_VALUE", // required
 * //           detail: "STRING_VALUE",
 * //         },
 * //       ],
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListDocumentsCommandInput - {@link ListDocumentsCommandInput}
 * @returns {@link ListDocumentsCommandOutput}
 * @see {@link ListDocumentsCommandInput} for command's `input` shape.
 * @see {@link ListDocumentsCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; or its cursor is not valid for this list.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example List the HR folder's documents that finished indexing
 * ```javascript
 * //
 * const input = {
 *   folder: "hr/",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   limit: 2,
 *   status: "indexed"
 * };
 * const command = new ListDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       byteSize: 482113,
 *       contentType: "application/pdf",
 *       createdAt: "2026-10-01T22:10:00.000Z",
 *       folder: "hr/",
 *       id: "doc-3b7f9e21",
 *       knowledgeBaseId: "KB4T7YQ2WL",
 *       name: "Leave policy",
 *       status: "indexed",
 *       updatedAt: "2026-10-01T22:14:31.000Z"
 *     }
 *   ],
 *   nextCursor: "c1.MEUCIQDl8z"
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
 * const command = new ListDocumentsCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListDocumentsCommand extends command<ListDocumentsCommandInput, ListDocumentsCommandOutput>(
  _ep0,
  _mw0,
  "ListDocuments",
  ListDocuments$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListDocumentsInput;
      output: ListDocumentsOutput;
    };
    sdk: {
      input: ListDocumentsCommandInput;
      output: ListDocumentsCommandOutput;
    };
  };
}
