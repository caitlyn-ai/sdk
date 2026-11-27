// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListKnowledgeBasesInput, ListKnowledgeBasesOutput } from "../models/models_0";
import { ListKnowledgeBases$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListKnowledgeBasesCommand}.
 */
export interface ListKnowledgeBasesCommandInput extends ListKnowledgeBasesInput {}
/**
 * @public
 *
 * The output of {@link ListKnowledgeBasesCommand}.
 */
export interface ListKnowledgeBasesCommandOutput extends ListKnowledgeBasesOutput, __MetadataBearer {}

/**
 * Lists the knowledge bases the caller may see, in every state, in a stable order that does not
 * change between pages. The server decides the default order; it is not yet recorded here.
 *
 * Knowledge bases still being created, being moved, that failed or that are being deleted are
 * listed too, each with its `status`. Document operations on a knowledge base that is not `ready`
 * are refused with 409 `CONFLICT`.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListKnowledgeBasesCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListKnowledgeBasesCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListKnowledgeBasesInput
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 *   status: "creating" || "ready" || "moving" || "failed" || "deleting",
 * };
 * const command = new ListKnowledgeBasesCommand(input);
 * const response = await client.send(command);
 * // { // ListKnowledgeBasesOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // KnowledgeBaseList // required
 * //     { // KnowledgeBase
 * //       id: "STRING_VALUE", // required
 * //       name: "STRING_VALUE", // required
 * //       description: "STRING_VALUE",
 * //       agentDescription: "STRING_VALUE",
 * //       status: "creating" || "ready" || "moving" || "failed" || "deleting", // required
 * //       documentCounts: { // DocumentCounts
 * //         processing: Number("long"), // required
 * //         failed: Number("long"), // required
 * //         outOfDate: Number("long"),
 * //       },
 * //       retrieval: { // RetrievalDefaults
 * //         resultsPerSearch: Number("int"),
 * //         minimumMatch: Number("float"),
 * //         minimumRelevance: Number("float"),
 * //       },
 * //       features: { // KnowledgeBaseFeatures
 * //         nearbyPassages: { // NearbyPassages
 * //           enabled: true || false, // required
 * //           count: Number("int"),
 * //         },
 * //         transcripts: { // TranscriptSettings
 * //           enabled: true || false, // required
 * //         },
 * //       },
 * //       engine: { // KnowledgeBaseEngine
 * //         embeddingModel: "STRING_VALUE", // required
 * //         reads: "text" || "text_and_images", // required
 * //         dimensions: Number("int"), // required
 * //         region: "STRING_VALUE", // required
 * //         searchType: "standard" || "layout_aware", // required
 * //       },
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //       updatedAt: new Date("TIMESTAMP"), // required
 * //       etag: "STRING_VALUE", // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListKnowledgeBasesCommandInput - {@link ListKnowledgeBasesCommandInput}
 * @returns {@link ListKnowledgeBasesCommandOutput}
 * @see {@link ListKnowledgeBasesCommandInput} for command's `input` shape.
 * @see {@link ListKnowledgeBasesCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
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
 * @example The first knowledge base
 * ```javascript
 * //
 * const input = {
 *   limit: 1
 * };
 * const command = new ListKnowledgeBasesCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       createdAt: "2026-09-01T22:10:00.000Z",
 *       description: "Harbour Freight's HR policies, for staff.",
 *       documentCounts: {
 *         failed: 2,
 *         processing: 3
 *       },
 *       etag: `"12"`,
 *       id: "KB4T7YQ2WL",
 *       name: "HR policies",
 *       status: "ready",
 *       updatedAt: "2026-11-10T01:04:31.000Z"
 *     }
 *   ],
 *   nextCursor: "c1.MEUCIQDk2b"
 * }
 * *\/
 * ```
 *
 * @example A caller without permission to list knowledge bases
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new ListKnowledgeBasesCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListKnowledgeBasesCommand extends command<ListKnowledgeBasesCommandInput, ListKnowledgeBasesCommandOutput>(
  _ep0,
  _mw0,
  "ListKnowledgeBases",
  ListKnowledgeBases$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListKnowledgeBasesInput;
      output: ListKnowledgeBasesOutput;
    };
    sdk: {
      input: ListKnowledgeBasesCommandInput;
      output: ListKnowledgeBasesCommandOutput;
    };
  };
}
