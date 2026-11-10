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
 * The stream ends with exactly one `message.completed` or `message.failed`. If the connection
 * drops, the SDK re-attaches with `ResumeConversationStream` and `Last-Event-ID`, so no event is
 * lost or repeated. Not retried automatically: a send that fails before the stream starts is
 * reported to the caller.
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
 * same idempotency key is still in progress.
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
 * filter or sort field the operation does not define; or its cursor is not valid for this list.
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
