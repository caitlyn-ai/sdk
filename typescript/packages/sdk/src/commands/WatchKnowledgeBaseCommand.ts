// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer, StreamingBlobPayloadOutputTypes } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { WatchKnowledgeBaseInput, WatchKnowledgeBaseOutput } from "../models/models_0";
import { WatchKnowledgeBase$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link WatchKnowledgeBaseCommand}.
 */
export interface WatchKnowledgeBaseCommandInput extends WatchKnowledgeBaseInput {}
/**
 * @public
 *
 * The output of {@link WatchKnowledgeBaseCommand}.
 */
export interface WatchKnowledgeBaseCommandOutput extends Omit<WatchKnowledgeBaseOutput, "events">, __MetadataBearer {
  events: StreamingBlobPayloadOutputTypes;
}

/**
 * Watches a knowledge base, or one document, folder or batch in it: a snapshot first, then each
 * change.
 *
 * Every connection starts with `snapshot`: the thing watched as it stands, its running and recently
 * finished jobs, and the progress of each document being processed. Then one event per change. A
 * reconnect needs no cursor, because it starts with a snapshot again; nothing is replayed and
 * nothing is lost. The SDKs build every scope's `watch()` and `wait()` on this: `wait()` returns once
 * no job on the thing is running, or raises the error of the job that failed. Events name a document
 * only to callers who may read it. The server ends the stream after at most an hour, and the SDKs
 * reconnect.
 *
 * What the caller needs depends on what it watches. The whole knowledge base needs the knowledge
 * base read permission and the files list permission, because the snapshot returns the knowledge
 * base and the documents' progress. One document or folder needs the files list permission. One
 * batch needs the ingestion list permission, because the snapshot returns the batch.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, WatchKnowledgeBaseCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, WatchKnowledgeBaseCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // WatchKnowledgeBaseInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   document: "STRING_VALUE",
 *   folder: "STRING_VALUE",
 *   batch: "STRING_VALUE",
 * };
 * const command = new WatchKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * // consume or destroy the stream to free the socket.
 * const bytes = await response.events.transformToByteArray();
 * // const str = await response.events.transformToString();
 * // response.events.destroy(); // only applicable to Node.js Readable streams.
 *
 * // { // WatchKnowledgeBaseOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   events: "<SdkStream>", // see \@smithy/types -> StreamingBlobPayloadOutputTypes // required
 * // };
 *
 * ```
 *
 * @param WatchKnowledgeBaseCommandInput - {@link WatchKnowledgeBaseCommandInput}
 * @returns {@link WatchKnowledgeBaseCommandOutput}
 * @see {@link WatchKnowledgeBaseCommandInput} for command's `input` shape.
 * @see {@link WatchKnowledgeBaseCommandOutput} for command's `response` shape.
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
 * @example Watch one document after a page reload
 * ```javascript
 * // The events arrive as a stream; the example shows only the request.
 * const input = {
 *   document: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new WatchKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * // consume or destroy the stream to free the socket.
 * const bytes = await response.events.transformToByteArray();
 * // const str = await response.events.transformToString();
 * // response.events.destroy(); // only applicable to Node.js Readable streams.
 *
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @example A knowledge base that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KBNOPE0000"
 * };
 * const command = new WatchKnowledgeBaseCommand(input);
 * const response = await client.send(command);
 * // consume or destroy the stream to free the socket.
 * const bytes = await response.events.transformToByteArray();
 * // const str = await response.events.transformToString();
 * // response.events.destroy(); // only applicable to Node.js Readable streams.
 *
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class WatchKnowledgeBaseCommand extends command<WatchKnowledgeBaseCommandInput, WatchKnowledgeBaseCommandOutput>(
  _ep0,
  _mw0,
  "WatchKnowledgeBase",
  WatchKnowledgeBase$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: WatchKnowledgeBaseInput;
      output: WatchKnowledgeBaseOutput;
    };
    sdk: {
      input: WatchKnowledgeBaseCommandInput;
      output: WatchKnowledgeBaseCommandOutput;
    };
  };
}
