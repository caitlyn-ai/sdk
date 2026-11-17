// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateKnowledgeBaseInput, CreateKnowledgeBaseOutput } from "../models/models_0";
import { CreateKnowledgeBase$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateKnowledgeBaseCommand}.
 */
export interface CreateKnowledgeBaseCommandInput extends CreateKnowledgeBaseInput {}
/**
 * @public
 *
 * The output of {@link CreateKnowledgeBaseCommand}.
 */
export interface CreateKnowledgeBaseCommandOutput extends CreateKnowledgeBaseOutput, __MetadataBearer {}

/**
 * Creates a knowledge base; setting it up continues after the response.
 *
 * Returns 202 with the knowledge base in `creating`, and `Location` names it; documents can be added
 * once it is `ready`. Where its documents are stored is decided by Caitlyn and never exposed.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateKnowledgeBaseCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateKnowledgeBaseCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateKnowledgeBaseInput
 *   name: "STRING_VALUE", // required
 *   description: "STRING_VALUE",
 *   agentDescription: "STRING_VALUE",
 *   retrieval: { // RetrievalDefaults
 *     resultsPerSearch: Number("int"),
 *     minimumMatch: Number("float"),
 *     minimumRelevance: Number("float"),
 *   },
 *   features: { // KnowledgeBaseFeatures
 *     nearbyPassages: { // NearbyPassages
 *       enabled: true || false, // required
 *       count: Number("int"),
 *     },
 *     transcripts: { // TranscriptSettings
 *       enabled: true || false, // required
 *     },
 *   },
 *   idempotencyKey: "STRING_VALUE",
 * };
 * const command = new CreateKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * // { // CreateKnowledgeBaseOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   knowledgeBase: { // KnowledgeBase
 * //     id: "STRING_VALUE", // required
 * //     name: "STRING_VALUE", // required
 * //     description: "STRING_VALUE",
 * //     agentDescription: "STRING_VALUE",
 * //     status: "creating" || "ready" || "moving" || "failed" || "deleting", // required
 * //     documentCounts: { // DocumentCounts
 * //       processing: Number("long"), // required
 * //       failed: Number("long"), // required
 * //       outOfDate: Number("long"),
 * //     },
 * //     retrieval: { // RetrievalDefaults
 * //       resultsPerSearch: Number("int"),
 * //       minimumMatch: Number("float"),
 * //       minimumRelevance: Number("float"),
 * //     },
 * //     features: { // KnowledgeBaseFeatures
 * //       nearbyPassages: { // NearbyPassages
 * //         enabled: true || false, // required
 * //         count: Number("int"),
 * //       },
 * //       transcripts: { // TranscriptSettings
 * //         enabled: true || false, // required
 * //       },
 * //     },
 * //     engine: { // KnowledgeBaseEngine
 * //       embeddingModel: "STRING_VALUE", // required
 * //       reads: "text" || "text_and_images", // required
 * //       dimensions: Number("int"), // required
 * //       region: "STRING_VALUE", // required
 * //       searchType: "standard" || "layout_aware", // required
 * //     },
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     updatedAt: new Date("TIMESTAMP"), // required
 * //     etag: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param CreateKnowledgeBaseCommandInput - {@link CreateKnowledgeBaseCommandInput}
 * @returns {@link CreateKnowledgeBaseCommandOutput}
 * @see {@link CreateKnowledgeBaseCommandInput} for command's `input` shape.
 * @see {@link CreateKnowledgeBaseCommandOutput} for command's `response` shape.
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
 * @example Create a knowledge base for HR policies
 * ```javascript
 * //
 * const input = {
 *   agentDescription: "Leave, pay, conduct and safety policies for Harbour Freight staff in New Zealand.",
 *   description: "Harbour Freight's HR policies, for staff.",
 *   idempotencyKey: "7d3e1f2a-4b5c-4d6e-8f70-81a2b3c4d5e6",
 *   name: "HR policies"
 * };
 * const command = new CreateKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"1"`,
 *   knowledgeBase: {
 *     agentDescription: "Leave, pay, conduct and safety policies for Harbour Freight staff in New Zealand.",
 *     createdAt: "2026-11-16T01:02:03.000Z",
 *     description: "Harbour Freight's HR policies, for staff.",
 *     etag: `"1"`,
 *     id: "KB4T7YQ2WL",
 *     name: "HR policies",
 *     status: "creating",
 *     updatedAt: "2026-11-16T01:02:03.000Z"
 *   },
 *   location: "/api/v3/knowledge-bases/KB4T7YQ2WL"
 * }
 * *\/
 * ```
 *
 * @example A caller who may not create knowledge bases
 * ```javascript
 * //
 * const input = {
 *   name: "HR policies"
 * };
 * const command = new CreateKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateKnowledgeBaseCommand extends command<CreateKnowledgeBaseCommandInput, CreateKnowledgeBaseCommandOutput>(
  _ep0,
  _mw0,
  "CreateKnowledgeBase",
  CreateKnowledgeBase$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateKnowledgeBaseInput;
      output: CreateKnowledgeBaseOutput;
    };
    sdk: {
      input: CreateKnowledgeBaseCommandInput;
      output: CreateKnowledgeBaseCommandOutput;
    };
  };
}
