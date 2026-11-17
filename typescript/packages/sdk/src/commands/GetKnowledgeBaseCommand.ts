// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetKnowledgeBaseInput, GetKnowledgeBaseOutput } from "../models/models_0";
import { GetKnowledgeBase$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetKnowledgeBaseCommand}.
 */
export interface GetKnowledgeBaseCommandInput extends GetKnowledgeBaseInput {}
/**
 * @public
 *
 * The output of {@link GetKnowledgeBaseCommand}.
 */
export interface GetKnowledgeBaseCommandOutput extends GetKnowledgeBaseOutput, __MetadataBearer {}

/**
 * Gets one knowledge base, with its settings and ETag.
 *
 * `agentDescription` and `engine` are shown only to callers who may change the knowledge base. A
 * knowledge base the caller may not see is 404, as one that does not exist is.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetKnowledgeBaseCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetKnowledgeBaseCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetKnowledgeBaseInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 * };
 * const command = new GetKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * // { // GetKnowledgeBaseOutput
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
 * @param GetKnowledgeBaseCommandInput - {@link GetKnowledgeBaseCommandInput}
 * @returns {@link GetKnowledgeBaseCommandOutput}
 * @see {@link GetKnowledgeBaseCommandInput} for command's `input` shape.
 * @see {@link GetKnowledgeBaseCommandOutput} for command's `response` shape.
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
 * @example A knowledge base, read by someone who may change it
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"12"`,
 *   knowledgeBase: {
 *     agentDescription: "Leave, pay, conduct and safety policies for Harbour Freight staff in New Zealand.",
 *     createdAt: "2026-09-01T22:10:00.000Z",
 *     description: "Harbour Freight's HR policies, for staff.",
 *     documentCounts: {
 *       failed: 0,
 *       outOfDate: 12,
 *       processing: 0
 *     },
 *     engine: {
 *       dimensions: 1024,
 *       embeddingModel: "cohere-embed-v4",
 *       reads: "text_and_images",
 *       region: "ap-southeast-2",
 *       searchType: "layout_aware"
 *     },
 *     etag: `"12"`,
 *     features: {
 *       nearbyPassages: {
 *         count: 1,
 *         enabled: true
 *       },
 *       transcripts: {
 *         enabled: true
 *       }
 *     },
 *     id: "KB4T7YQ2WL",
 *     name: "HR policies",
 *     retrieval: {
 *       minimumMatch: 0.3,
 *       minimumRelevance: 0.5,
 *       resultsPerSearch: 6
 *     },
 *     status: "ready",
 *     updatedAt: "2026-11-10T01:04:31.000Z"
 *   }
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
 * const command = new GetKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetKnowledgeBaseCommand extends command<GetKnowledgeBaseCommandInput, GetKnowledgeBaseCommandOutput>(
  _ep0,
  _mw0,
  "GetKnowledgeBase",
  GetKnowledgeBase$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetKnowledgeBaseInput;
      output: GetKnowledgeBaseOutput;
    };
    sdk: {
      input: GetKnowledgeBaseCommandInput;
      output: GetKnowledgeBaseCommandOutput;
    };
  };
}
