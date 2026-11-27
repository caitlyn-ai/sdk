// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer, StreamingBlobPayloadOutputTypes } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { SendMessageInput, SendMessageOutput } from "../models/models_0";
import { SendMessage$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link SendMessageCommand}.
 */
export interface SendMessageCommandInput extends SendMessageInput {}
/**
 * @public
 *
 * The output of {@link SendMessageCommand}.
 */
export interface SendMessageCommandOutput extends Omit<SendMessageOutput, "events">, __MetadataBearer {
  events: StreamingBlobPayloadOutputTypes;
}

/**
 * Sends a message and streams the answer as server-sent events.
 *
 * The message is sent when the call is made, whether or not anyone reads the stream. The stream ends
 * with exactly one `message.completed` or `message.failed`. If the connection drops, the SDK
 * re-attaches with `WatchConversation` and `Last-Event-ID`, so no event is lost or repeated. Not retried automatically: a send that fails before the stream starts is
 * reported to the caller.
 *
 * A message may carry documents in `attachments`, each named by an upload reserved for this
 * conversation. The SDKs also take files there: each file is uploaded for the conversation first,
 * and the message is sent once every upload has arrived.
 *
 * Only a participant may send: whoever started the conversation, or someone it is shared with for
 * writing (the update grant), who may still see the conversation's agent and holds that agent's
 * version access grant (the conversation's version may be `live`). A caller without any of
 * these gets 404, so revoking someone's access to the agent stops them chatting in conversations
 * they already started.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, SendMessageCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, SendMessageCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // SendMessageInput
 *   conversationId: "STRING_VALUE", // required
 *   message: "STRING_VALUE", // required
 *   context: [ // ContextItemList
 *     { // ContextItem
 *       type: "STRING_VALUE", // required
 *       label: "STRING_VALUE", // required
 *       uri: "STRING_VALUE",
 *       data: "DOCUMENT_VALUE",
 *     },
 *   ],
 *   attachments: [ // AttachmentList
 *     { // AttachmentReference
 *       uploadId: "STRING_VALUE", // required
 *     },
 *   ],
 * };
 * const command = new SendMessageCommand(input);
 * const response = await client.send(command);
 * // consume or destroy the stream to free the socket.
 * const bytes = await response.events.transformToByteArray();
 * // const str = await response.events.transformToString();
 * // response.events.destroy(); // only applicable to Node.js Readable streams.
 *
 * // { // SendMessageOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   events: "<SdkStream>", // see \@smithy/types -> StreamingBlobPayloadOutputTypes // required
 * // };
 *
 * ```
 *
 * @param SendMessageCommandInput - {@link SendMessageCommandInput}
 * @returns {@link SendMessageCommandOutput}
 * @see {@link SendMessageCommandInput} for command's `input` shape.
 * @see {@link SendMessageCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress. An agent version that live points at
 * (`VERSION_IN_USE`) or that live history names (`VERSION_IN_HISTORY`) cannot be deleted. A
 * document still being ingested takes no new version (`DOCUMENT_INGESTION_IN_PROGRESS`), and an
 * ingestion batch with unresolved items cannot start (`INGESTION_BATCH_UNRESOLVED`).
 * `TARGET_IN_USE` refuses a write to a path an ingestion batch has reserved for a new document
 * (CreateDocument, or UpdateDocument renaming or moving a document onto it) while the batch holds
 * the path; once the batch's reservation has lapsed, the path is free and the write goes ahead. It
 * is also an ingestion batch item's failure when the document its plan found changed, or something
 * else took it, before the batch could act on it. `DOCUMENT_INGESTION_IN_PROGRESS` and
 * `TARGET_IN_USE` answers carry `Retry-After`: for `TARGET_IN_USE`, the seconds left on the batch's
 * reservation. A document whose versions are not numbered yet cannot have one deleted by number
 * (`VERSIONS_NOT_NUMBERED`).
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link PayloadTooLargeError} (client fault)
 *  The body, a file or the send `context` is over its documented limit.
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
 * @example Ask a question
 * ```javascript
 * // The answer arrives as a stream of events; the example shows only the request.
 * const input = {
 *   conversationId: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *   message: "How much annual leave do part-time staff get?"
 * };
 * const command = new SendMessageCommand(input);
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
 * @example Ask about an attached document
 * ```javascript
 * // The upload was reserved with CreateUpload and `purpose.conversationId` set to this conversation, and its bytes have arrived. The SDKs do both when given a file: `conversation.send(text, { attachments: ['./leave.pdf'] })`.
 * const input = {
 *   attachments: [
 *     {
 *       uploadId: "0193a6f2-1112-7a2b-8c3d-4e5f60718293"
 *     }
 *   ],
 *   conversationId: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *   message: "Does this leave form match our policy?"
 * };
 * const command = new SendMessageCommand(input);
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
 * @example An attachment whose upload cannot be used
 * ```javascript
 * //
 * const input = {
 *   attachments: [
 *     {
 *       uploadId: "0193a6f2-1112-7a2b-8c3d-4e5f60718293"
 *     },
 *     {
 *       uploadId: "0193a6f2-1113-7a2b-8c3d-4e5f60718293"
 *     }
 *   ],
 *   conversationId: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *   message: "Summarise these."
 * };
 * const command = new SendMessageCommand(input);
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
 * @example A conversation that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   conversationId: "0193a6f2-0000-7000-8000-000000000000",
 *   message: "Hello"
 * };
 * const command = new SendMessageCommand(input);
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
 * @example An answer is already being written
 * ```javascript
 * //
 * const input = {
 *   conversationId: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *   message: "And for casual staff?"
 * };
 * const command = new SendMessageCommand(input);
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
export class SendMessageCommand extends command<SendMessageCommandInput, SendMessageCommandOutput>(
  _ep0,
  _mw0,
  "SendMessage",
  SendMessage$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: SendMessageInput;
      output: SendMessageOutput;
    };
    sdk: {
      input: SendMessageCommandInput;
      output: SendMessageCommandOutput;
    };
  };
}
