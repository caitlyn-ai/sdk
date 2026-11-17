// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { UpdateKnowledgeBaseInput, UpdateKnowledgeBaseOutput } from "../models/models_0";
import { UpdateKnowledgeBase$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link UpdateKnowledgeBaseCommand}.
 */
export interface UpdateKnowledgeBaseCommandInput extends UpdateKnowledgeBaseInput {}
/**
 * @public
 *
 * The output of {@link UpdateKnowledgeBaseCommand}.
 */
export interface UpdateKnowledgeBaseCommandOutput extends UpdateKnowledgeBaseOutput, __MetadataBearer {}

/**
 * Changes a knowledge base's settings; `If-Match` is required.
 *
 * Members that are absent stay unchanged, nested objects are merged and lists are replaced whole.
 * Name a member in `clear` to return it to its default. Metadata fields are changed one at a
 * time, with the field operations. Returns the knowledge base and its new ETag.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, UpdateKnowledgeBaseCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, UpdateKnowledgeBaseCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // UpdateKnowledgeBaseInput
 *   name: "STRING_VALUE",
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
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   ifMatch: "STRING_VALUE", // required
 *   clear: [ // ClearableKnowledgeBaseFieldList
 *     "description" || "agentDescription",
 *   ],
 * };
 * const command = new UpdateKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * // { // UpdateKnowledgeBaseOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
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
 * @param UpdateKnowledgeBaseCommandInput - {@link UpdateKnowledgeBaseCommandInput}
 * @returns {@link UpdateKnowledgeBaseCommandOutput}
 * @see {@link UpdateKnowledgeBaseCommandInput} for command's `input` shape.
 * @see {@link UpdateKnowledgeBaseCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link PreconditionFailedError} (client fault)
 *  `If-Match` does not match the resource's current ETag: it changed since the caller read it.
 *
 * @throws {@link PreconditionRequiredError} (client fault)
 *  The update sent no `If-Match` header; read the resource and send its ETag.
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
 * @example Rename a knowledge base
 * ```javascript
 * //
 * const input = {
 *   ifMatch: `"12"`,
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   name: "HR and pay policies"
 * };
 * const command = new UpdateKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"13"`,
 *   knowledgeBase: {
 *     createdAt: "2026-09-01T22:10:00.000Z",
 *     etag: `"13"`,
 *     id: "KB4T7YQ2WL",
 *     name: "HR and pay policies",
 *     status: "ready",
 *     updatedAt: "2026-11-16T01:02:03.000Z"
 *   }
 * }
 * *\/
 * ```
 *
 * @example The knowledge base changed since it was read
 * ```javascript
 * //
 * const input = {
 *   ifMatch: `"11"`,
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   name: "HR and pay policies"
 * };
 * const command = new UpdateKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class UpdateKnowledgeBaseCommand extends command<UpdateKnowledgeBaseCommandInput, UpdateKnowledgeBaseCommandOutput>(
  _ep0,
  _mw0,
  "UpdateKnowledgeBase",
  UpdateKnowledgeBase$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: UpdateKnowledgeBaseInput;
      output: UpdateKnowledgeBaseOutput;
    };
    sdk: {
      input: UpdateKnowledgeBaseCommandInput;
      output: UpdateKnowledgeBaseCommandOutput;
    };
  };
}
