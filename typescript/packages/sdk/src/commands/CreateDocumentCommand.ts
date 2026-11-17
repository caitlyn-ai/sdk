// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateDocumentInput, CreateDocumentOutput } from "../models/models_0";
import { CreateDocument$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateDocumentCommand}.
 */
export interface CreateDocumentCommandInput extends CreateDocumentInput {}
/**
 * @public
 *
 * The output of {@link CreateDocumentCommand}.
 */
export interface CreateDocumentCommandOutput extends CreateDocumentOutput, __MetadataBearer {}

/**
 * Creates a document from an upload; ingestion continues after the response.
 *
 * Returns 202 with the document in its initial state and the Operation that tracks ingestion, and
 * `Location` names the document: read it with GetDocument, or wait for it with the SDKs'
 * `wait()`. Metadata sent here is written with the document before ingestion starts, so
 * even the first ingestion keeps it. Needs the files permission, read access to the knowledge base
 * and access to the folder; it does not need update access to the knowledge base, which is for the
 * knowledge base's own configuration.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateDocumentCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateDocumentCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateDocumentInput
 *   sourceUrl: "STRING_VALUE",
 *   externalId: "STRING_VALUE",
 *   metadata: { // DocumentMetadata
 *     "<keys>": "DOCUMENT_VALUE",
 *   },
 *   extraMetadata: { // ExtraMetadata
 *     "<keys>": "DOCUMENT_VALUE",
 *   },
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   idempotencyKey: "STRING_VALUE",
 *   uploadId: "STRING_VALUE", // required
 *   folder: "STRING_VALUE", // required
 *   name: "STRING_VALUE",
 * };
 * const command = new CreateDocumentCommand(input);
 * const response = await client.send(command);
 * // { // CreateDocumentOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
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
 * //   operation: { // Operation
 * //     id: "STRING_VALUE", // required
 * //     kind: "document_ingestion" || "document_update" || "folder_change" || "permissions_change" || "knowledge_base_deletion" || "layout_aware_search" || "fill_in" || "reprocess", // required
 * //     status: "queued" || "running" || "succeeded" || "completed_with_failures" || "failed" || "cancelled", // required
 * //     target: { // OperationTarget
 * //       type: "knowledge_base" || "folder" || "document", // required
 * //       id: "STRING_VALUE", // required
 * //       knowledgeBaseId: "STRING_VALUE",
 * //     },
 * //     progress: { // OperationProgress
 * //       completed: Number("long"), // required
 * //       total: Number("long"),
 * //       failed: Number("long"),
 * //       unit: "documents" || "passages" || "stages", // required
 * //     },
 * //     percent: Number("int"),
 * //     eta: {
 * //       seconds: {
 * //         low: Number("double"), // required
 * //         high: Number("double"), // required
 * //       },
 * //     },
 * //     costSoFar: {
 * //       low: Number("double"), // required
 * //       high: Number("double"), // required
 * //       unit: "usd" || "percent_of_plan", // required
 * //     },
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     startedAt: new Date("TIMESTAMP"),
 * //     updatedAt: new Date("TIMESTAMP"),
 * //     endedAt: new Date("TIMESTAMP"),
 * //     createdBy: { // Actor
 * //       userId: "STRING_VALUE",
 * //       apiClientId: "STRING_VALUE",
 * //       displayName: "STRING_VALUE", // required
 * //     },
 * //     error: { // OperationError
 * //       code: "STRING_VALUE", // required
 * //       detail: "STRING_VALUE",
 * //     },
 * //     partialFailures: [
 * //       {
 * //         targetId: "STRING_VALUE",
 * //         code: "STRING_VALUE", // required
 * //         detail: "STRING_VALUE",
 * //       },
 * //     ],
 * //   },
 * // };
 *
 * ```
 *
 * @param CreateDocumentCommandInput - {@link CreateDocumentCommandInput}
 * @returns {@link CreateDocumentCommandOutput}
 * @see {@link CreateDocumentCommandInput} for command's `input` shape.
 * @see {@link CreateDocumentCommandOutput} for command's `response` shape.
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
 * @example Add an uploaded file to the HR folder
 * ```javascript
 * //
 * const input = {
 *   externalId: "hr/leave-policy",
 *   folder: "/hr/",
 *   idempotencyKey: "3f0c9a1e-5d2b-4f7a-9c1e-2b8d4a6f0e13",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   metadata: {
 *     policyOwner: "hr",
 *     title: "Leave policy"
 *   },
 *   name: "Leave policy",
 *   sourceUrl: "https://intranet.harbourfreight.example/hr/leave-policy",
 *   uploadId: "0193a6f2-1111-7a2b-8c3d-4e5f60718293"
 * };
 * const command = new CreateDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   document: {
 *     createdAt: "2026-11-10T01:02:03.000Z",
 *     etag: `"1"`,
 *     externalId: "hr/leave-policy",
 *     folder: "/hr/",
 *     id: "doc-3b7f9e21",
 *     knowledgeBaseId: "KB4T7YQ2WL",
 *     metadata: {
 *       policyOwner: "hr",
 *       title: "Leave policy"
 *     },
 *     name: "Leave policy.pdf",
 *     sourceUrl: "https://intranet.harbourfreight.example/hr/leave-policy",
 *     status: "pending",
 *     updatedAt: "2026-11-10T01:02:03.000Z",
 *     versionCount: 1
 *   },
 *   etag: `"1"`,
 *   location: "/api/v3/knowledge-bases/KB4T7YQ2WL/documents/doc-3b7f9e21",
 *   operation: {
 *     createdAt: "2026-11-10T01:02:03.000Z",
 *     id: "0193a6f2-2222-7b3c-9d4e-5f6071829304",
 *     kind: "document_ingestion",
 *     status: "queued"
 *   }
 * }
 * *\/
 * ```
 *
 * @example The upload was already used, or has expired
 * ```javascript
 * //
 * const input = {
 *   folder: "/hr/",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   uploadId: "0193a6f2-1111-7a2b-8c3d-4e5f60718293"
 * };
 * const command = new CreateDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @example A metadata field the knowledge base does not define
 * ```javascript
 * //
 * const input = {
 *   folder: "/hr/",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   metadata: {
 *     policyOwnr: "hr"
 *   },
 *   uploadId: "0193a6f2-1111-7a2b-8c3d-4e5f60718293"
 * };
 * const command = new CreateDocumentCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateDocumentCommand extends command<CreateDocumentCommandInput, CreateDocumentCommandOutput>(
  _ep0,
  _mw0,
  "CreateDocument",
  CreateDocument$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateDocumentInput;
      output: CreateDocumentOutput;
    };
    sdk: {
      input: CreateDocumentCommandInput;
      output: CreateDocumentCommandOutput;
    };
  };
}
