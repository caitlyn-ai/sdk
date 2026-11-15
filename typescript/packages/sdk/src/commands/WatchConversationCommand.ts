// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer, StreamingBlobPayloadOutputTypes } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { WatchConversationInput, WatchConversationOutput } from "../models/models_0";
import { WatchConversation$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link WatchConversationCommand}.
 */
export interface WatchConversationCommandInput extends WatchConversationInput {}
/**
 * @public
 *
 * The output of {@link WatchConversationCommand}.
 */
export interface WatchConversationCommandOutput extends Omit<WatchConversationOutput, "events">, __MetadataBearer {
  events: StreamingBlobPayloadOutputTypes;
}

/**
 * Watches a conversation: the answer being written, if any, then every answer after it, until the
 * caller closes the stream. An answer whose stream ended moments before the watch opened may still
 * be delivered, from its `message.started` event; match answers on your own message ID.
 *
 * With `Last-Event-ID`, it resumes from the event after that one, so a dropped connection loses
 * nothing; the SDKs use this to re-attach to `SendMessage`, and to reconnect a dropped watch. When
 * the answer that event belongs to has ended, or can no longer be replayed, the watch sends
 * `stream.reset` with a new cursor instead, then carries on. Each answer ends with
 * `message.completed` or `message.failed`, which end that answer but not the stream, so
 * `waitUntil`-style helpers watch for the event they need and then close.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, WatchConversationCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, WatchConversationCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // WatchConversationInput
 *   conversationId: "STRING_VALUE", // required
 *   lastEventId: "STRING_VALUE",
 * };
 * const command = new WatchConversationCommand(input);
 * const response = await client.send(command);
 * // consume or destroy the stream to free the socket.
 * const bytes = await response.events.transformToByteArray();
 * // const str = await response.events.transformToString();
 * // response.events.destroy(); // only applicable to Node.js Readable streams.
 *
 * // { // WatchConversationOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   events: "<SdkStream>", // see \@smithy/types -> StreamingBlobPayloadOutputTypes // required
 * // };
 *
 * ```
 *
 * @param WatchConversationCommandInput - {@link WatchConversationCommandInput}
 * @returns {@link WatchConversationCommandOutput}
 * @see {@link WatchConversationCommandInput} for command's `input` shape.
 * @see {@link WatchConversationCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; its cursor is not valid for this list; or it
 * asks to delete `draft` or `production`, which every agent keeps.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Resume after a dropped connection
 * ```javascript
 * // The events arrive as a stream; the example shows only the request.
 * const input = {
 *   conversationId: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *   lastEventId: "8f14e45f-ceea-4c6b-9d2a-1b3c5d7e9f20.42"
 * };
 * const command = new WatchConversationCommand(input);
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
 *   conversationId: "0193a6f2-0000-7000-8000-000000000000"
 * };
 * const command = new WatchConversationCommand(input);
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
export class WatchConversationCommand extends command<WatchConversationCommandInput, WatchConversationCommandOutput>(
  _ep0,
  _mw0,
  "WatchConversation",
  WatchConversation$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: WatchConversationInput;
      output: WatchConversationOutput;
    };
    sdk: {
      input: WatchConversationCommandInput;
      output: WatchConversationCommandOutput;
    };
  };
}
