// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetDocumentInput, GetDocumentOutput } from "../models/models_0";
import { GetDocument$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetDocumentCommand}.
 */
export interface GetDocumentCommandInput extends GetDocumentInput {}
/**
 * @public
 *
 * The output of {@link GetDocumentCommand}.
 */
export interface GetDocumentCommandOutput extends GetDocumentOutput, __MetadataBearer {}

/**
 * Gets one document in a knowledge base, with its status.
 *
 * `status` says where the current version is in its lifecycle; `indexed`, `partially_indexed` and
 * `failed` are final. A document in a folder the caller may not see is 404, as one that does not
 * exist is. `processing` says how far the work on it has got; follow it with the scope's `watch()`, or
 * `wait()` until it is done.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetDocumentCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetDocumentCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetDocumentInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 * };
 * const command = new GetDocumentCommand(input);
 * const response = await client.send(command);
 * // { // GetDocumentOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   document: { // Document
 * //     id: "STRING_VALUE", // required
 * //     knowledgeBaseId: "STRING_VALUE", // required
 * //     name: "STRING_VALUE", // required
 * //     folder: "STRING_VALUE", // required
 * //     status: "pending" || "processing" || "indexed" || "partially_indexed" || "failed" || "deleting", // required
 * //     stage: "STRING_VALUE",
 * //     contentType: "STRING_VALUE",
 * //     byteSize: Number("long"),
 * //     sha256: "STRING_VALUE",
 * //     version: Number("int"),
 * //     versionCount: Number("int"),
 * //     latestVersion: { // LatestVersion
 * //       number: Number("int"), // required
 * //       status: "pending" || "processing" || "indexed" || "partially_indexed" || "failed" || "deleting", // required
 * //       stage: "STRING_VALUE",
 * //       failure: { // DocumentFailure
 * //         code: "file_unreadable" || "processing_interrupted" || "processing_failed" || "cancelled", // required
 * //         message: "STRING_VALUE", // required
 * //       },
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //     },
 * //     superseded: true || false,
 * //     sourceUrl: "STRING_VALUE",
 * //     externalId: "STRING_VALUE",
 * //     metadata: { // DocumentMetadata
 * //       "<keys>": "DOCUMENT_VALUE",
 * //     },
 * //     extraMetadata: { // ExtraMetadata
 * //       "<keys>": "DOCUMENT_VALUE",
 * //     },
 * //     readers: { // Readers
 * //       kind: "inherit" || "everyone" || "specific", // required
 * //       roles: [ // RoleIdList
 * //         "STRING_VALUE",
 * //       ],
 * //       people: [ // UserIdList
 * //         "STRING_VALUE",
 * //       ],
 * //     },
 * //     inheritedFrom: "STRING_VALUE",
 * //     outOfDate: true || false,
 * //     pageCount: Number("int"),
 * //     durationSeconds: Number("double"),
 * //     processing: { // DocumentProcessing
 * //       kind: "ingest" || "fill_in" || "reprocess" || "reembed", // required
 * //       stage: "pages" || "content" || "pictures" || "transcript" || "frames" || "metadata" || "seams" || "segments" || "passages" || "chunks" || "index" || "document" || "reembed",
 * //       percent: Number("int"), // required
 * //       eta: { // Eta
 * //         seconds: { // NumberRange
 * //           low: Number("double"), // required
 * //           high: Number("double"), // required
 * //         },
 * //       },
 * //       estimate: { // ProcessingEstimate
 * //         durationSeconds: {
 * //           low: Number("double"), // required
 * //           high: Number("double"), // required
 * //         },
 * //         cost: { // Cost
 * //           low: Number("double"), // required
 * //           high: Number("double"), // required
 * //           unit: "usd" || "percent_of_plan", // required
 * //         },
 * //         refined: true || false, // required
 * //       },
 * //       startedAt: new Date("TIMESTAMP"), // required
 * //       updatedAt: new Date("TIMESTAMP"), // required
 * //     },
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     updatedAt: new Date("TIMESTAMP"), // required
 * //     partialFailures: [ // PartialFailureList
 * //       { // PartialFailure
 * //         targetId: "STRING_VALUE",
 * //         code: "STRING_VALUE", // required
 * //         detail: "STRING_VALUE",
 * //       },
 * //     ],
 * //     failure: {
 * //       code: "file_unreadable" || "processing_interrupted" || "processing_failed" || "cancelled", // required
 * //       message: "STRING_VALUE", // required
 * //     },
 * //     etag: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param GetDocumentCommandInput - {@link GetDocumentCommandInput}
 * @returns {@link GetDocumentCommandOutput}
 * @see {@link GetDocumentCommandInput} for command's `input` shape.
 * @see {@link GetDocumentCommandOutput} for command's `response` shape.
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
 * @example A document that has finished indexing
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   document: {
 *     byteSize: 482113,
 *     contentType: "application/pdf",
 *     createdAt: "2026-11-10T01:02:03.000Z",
 *     etag: `"2"`,
 *     externalId: "hr/leave-policy",
 *     folder: "/hr/",
 *     id: "doc-3b7f9e21",
 *     inheritedFrom: "/hr/",
 *     knowledgeBaseId: "KB4T7YQ2WL",
 *     metadata: {
 *       policyOwner: "hr",
 *       title: "Leave policy"
 *     },
 *     name: "Leave policy.pdf",
 *     pageCount: 14,
 *     readers: {
 *       kind: "inherit"
 *     },
 *     sourceUrl: "https://intranet.harbourfreight.example/hr/leave-policy",
 *     status: "indexed",
 *     updatedAt: "2026-11-10T01:04:31.000Z",
 *     version: 2,
 *     versionCount: 2
 *   },
 *   etag: `"2"`
 * }
 * *\/
 * ```
 *
 * @example A document whose file could not be read
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-5d2e8a90",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   document: {
 *     byteSize: 1048576,
 *     contentType: "application/pdf",
 *     createdAt: "2026-11-10T01:02:03.000Z",
 *     etag: `"1"`,
 *     failure: {
 *       code: "file_unreadable",
 *       message: "The file could not be read: it may be damaged, password-protected or not the file type its name says. Check the file, then delete the document and add it again."
 *     },
 *     folder: "/legal/",
 *     id: "doc-5d2e8a90",
 *     knowledgeBaseId: "KB4T7YQ2WL",
 *     name: "Scanned contract.pdf",
 *     status: "failed",
 *     updatedAt: "2026-11-10T01:03:40.000Z",
 *     versionCount: 1
 *   },
 *   etag: `"1"`
 * }
 * *\/
 * ```
 *
 * @example A document that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-00000000",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetDocumentCommand extends command<GetDocumentCommandInput, GetDocumentCommandOutput>(
  _ep0,
  _mw0,
  "GetDocument",
  GetDocument$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetDocumentInput;
      output: GetDocumentOutput;
    };
    sdk: {
      input: GetDocumentCommandInput;
      output: GetDocumentCommandOutput;
    };
  };
}
