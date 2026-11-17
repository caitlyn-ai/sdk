// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CancelDocumentProcessingInput, CancelDocumentProcessingOutput } from "../models/models_0";
import { CancelDocumentProcessing$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CancelDocumentProcessingCommand}.
 */
export interface CancelDocumentProcessingCommandInput extends CancelDocumentProcessingInput {}
/**
 * @public
 *
 * The output of {@link CancelDocumentProcessingCommand}.
 */
export interface CancelDocumentProcessingCommandOutput extends CancelDocumentProcessingOutput, __MetadataBearer {}

/**
 * Stops the work running on a document: its ingestion, a fill-in or reprocessing.
 *
 * A stopped first version removes the document; a stopped new version leaves the current one
 * serving. Until stopping running work is built, every call is refused with 409 `CONFLICT` ("This
 * document's processing can't be stopped yet"), so callers can build against it now.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CancelDocumentProcessingCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CancelDocumentProcessingCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CancelDocumentProcessingInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   documentId: "STRING_VALUE", // required
 * };
 * const command = new CancelDocumentProcessingCommand(input);
 * const response = await client.send(command);
 * // { // CancelDocumentProcessingOutput
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
 * //       kind: "inherit" || "public" || "everyone" || "specific", // required
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
 * @param CancelDocumentProcessingCommandInput - {@link CancelDocumentProcessingCommandInput}
 * @returns {@link CancelDocumentProcessingCommandOutput}
 * @see {@link CancelDocumentProcessingCommandInput} for command's `input` shape.
 * @see {@link CancelDocumentProcessingCommandOutput} for command's `response` shape.
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
 * @example Stop a document's ingestion
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new CancelDocumentProcessingCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   document: {
 *     createdAt: "2026-11-10T01:02:03.000Z",
 *     etag: `"5"`,
 *     folder: "/hr/",
 *     id: "doc-3b7f9e21",
 *     knowledgeBaseId: "KB4T7YQ2WL",
 *     name: "Leave policy.pdf",
 *     status: "processing",
 *     updatedAt: "2026-11-16T01:02:03.000Z"
 *   },
 *   etag: `"5"`
 * }
 * *\/
 * ```
 *
 * @example Until stopping is built
 * ```javascript
 * //
 * const input = {
 *   documentId: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new CancelDocumentProcessingCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CancelDocumentProcessingCommand extends command<CancelDocumentProcessingCommandInput, CancelDocumentProcessingCommandOutput>(
  _ep0,
  _mw0,
  "CancelDocumentProcessing",
  CancelDocumentProcessing$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CancelDocumentProcessingInput;
      output: CancelDocumentProcessingOutput;
    };
    sdk: {
      input: CancelDocumentProcessingCommandInput;
      output: CancelDocumentProcessingCommandOutput;
    };
  };
}
