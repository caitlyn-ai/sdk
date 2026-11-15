// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer, StreamingBlobPayloadOutputTypes } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { WatchWorkspaceEventsInput, WatchWorkspaceEventsOutput } from "../models/models_0";
import { WatchWorkspaceEvents$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link WatchWorkspaceEventsCommand}.
 */
export interface WatchWorkspaceEventsCommandInput extends WatchWorkspaceEventsInput {}
/**
 * @public
 *
 * The output of {@link WatchWorkspaceEventsCommand}.
 */
export interface WatchWorkspaceEventsCommandOutput extends Omit<WatchWorkspaceEventsOutput, "events">, __MetadataBearer {
  events: StreamingBlobPayloadOutputTypes;
}

/**
 * Streams the workspace's events the caller asks for, from a cursor or from now.
 *
 * A stream listens to what it names and nothing else: give `type`, `conversationId`, or both.
 * Every event is about a subject (a conversation, for now), and the caller receives it only when
 * it may read that subject, decided per event as a read of the subject would be: the same
 * permission and, for a token, the same scope. An answer, a tool call or an input request needs
 * what `WatchConversation` needs; a token whose scopes leave out conversation transcripts receives
 * none of them.
 *
 * Each event's `id` is a cursor. Send it back as `after` (or `Last-Event-ID` on a reconnect) to
 * carry on from it without missing or repeating an event; without either, the stream starts now.
 * A cursor the stream cannot carry on from is answered with `stream.reset` and a new cursor, not
 * an error. To wait for something your own call will cause, open the stream first, then make the
 * call.
 *
 * Catching up after a cursor covers activity through the v3 API. A conversation event comes
 * with its content, in the same structures as the conversation's own stream.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, WatchWorkspaceEventsCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, WatchWorkspaceEventsCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // WatchWorkspaceEventsInput
 *   types: [ // WorkspaceEventTypeList
 *     "STRING_VALUE",
 *   ],
 *   conversationIds: [ // ConversationIdList
 *     "STRING_VALUE",
 *   ],
 *   after: "STRING_VALUE",
 *   lastEventId: "STRING_VALUE",
 * };
 * const command = new WatchWorkspaceEventsCommand(input);
 * const response = await client.send(command);
 * // consume or destroy the stream to free the socket.
 * const bytes = await response.events.transformToByteArray();
 * // const str = await response.events.transformToString();
 * // response.events.destroy(); // only applicable to Node.js Readable streams.
 *
 * // { // WatchWorkspaceEventsOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   events: "<SdkStream>", // see \@smithy/types -> StreamingBlobPayloadOutputTypes // required
 * // };
 *
 * ```
 *
 * @param WatchWorkspaceEventsCommandInput - {@link WatchWorkspaceEventsCommandInput}
 * @returns {@link WatchWorkspaceEventsCommandOutput}
 * @see {@link WatchWorkspaceEventsCommandInput} for command's `input` shape.
 * @see {@link WatchWorkspaceEventsCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; its cursor is not valid for this list; or it
 * asks to delete `draft` or `production`, which every agent keeps.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Wait for any answer in one conversation
 * ```javascript
 * // The events arrive as a stream; the example shows only the request.
 * const input = {
 *   conversationIds: [
 *     "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47"
 *   ],
 *   types: [
 *     "message.completed",
 *     "message.failed"
 *   ]
 * };
 * const command = new WatchWorkspaceEventsCommand(input);
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
 * @example Carry on after the last event received
 * ```javascript
 * // The events arrive as a stream; the example shows only the request.
 * const input = {
 *   after: "0193a6f3-0a1b-7c2d-8e3f-405162738495",
 *   types: [
 *     "conversation.created"
 *   ]
 * };
 * const command = new WatchWorkspaceEventsCommand(input);
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
 * @example A stream that names nothing to listen to
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new WatchWorkspaceEventsCommand(input);
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
export class WatchWorkspaceEventsCommand extends command<WatchWorkspaceEventsCommandInput, WatchWorkspaceEventsCommandOutput>(
  _ep0,
  _mw0,
  "WatchWorkspaceEvents",
  WatchWorkspaceEvents$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: WatchWorkspaceEventsInput;
      output: WatchWorkspaceEventsOutput;
    };
    sdk: {
      input: WatchWorkspaceEventsCommandInput;
      output: WatchWorkspaceEventsCommandOutput;
    };
  };
}
