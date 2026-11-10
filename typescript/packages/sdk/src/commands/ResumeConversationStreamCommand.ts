// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer, StreamingBlobPayloadOutputTypes } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ResumeConversationStreamInput, ResumeConversationStreamOutput } from "../models/models_0";
import { ResumeConversationStream$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ResumeConversationStreamCommand}.
 */
export interface ResumeConversationStreamCommandInput extends ResumeConversationStreamInput {}
/**
 * @public
 *
 * The output of {@link ResumeConversationStreamCommand}.
 */
export interface ResumeConversationStreamCommandOutput extends Omit<ResumeConversationStreamOutput, "events">, __MetadataBearer {
  events: StreamingBlobPayloadOutputTypes;
}

/**
 * Re-attaches to the answer that is being written, from the event after `Last-Event-ID`.
 *
 * Used by the SDKs after a dropped connection; callers rarely need it directly. When no answer is
 * being written, the stream ends at once.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ResumeConversationStreamCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ResumeConversationStreamCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ResumeConversationStreamInput
 *   conversationId: "STRING_VALUE", // required
 *   lastEventId: "STRING_VALUE",
 * };
 * const command = new ResumeConversationStreamCommand(input);
 * const response = await client.send(command);
 * // consume or destroy the stream to free the socket.
 * const bytes = await response.events.transformToByteArray();
 * // const str = await response.events.transformToString();
 * // response.events.destroy(); // only applicable to Node.js Readable streams.
 *
 * // { // ResumeConversationStreamOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   events: "<SdkStream>", // see \@smithy/types -> StreamingBlobPayloadOutputTypes // required
 * // };
 *
 * ```
 *
 * @param ResumeConversationStreamCommandInput - {@link ResumeConversationStreamCommandInput}
 * @returns {@link ResumeConversationStreamCommandOutput}
 * @see {@link ResumeConversationStreamCommandInput} for command's `input` shape.
 * @see {@link ResumeConversationStreamCommandOutput} for command's `response` shape.
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
 * filter or sort field the operation does not define; or its cursor is not valid for this list.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Resume after a dropped connection
 * ```javascript
 * // The answer arrives as a stream of events; the example shows only the request.
 * const input = {
 *   conversationId: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47",
 *   lastEventId: "0193a6f2-9b10-7c3d-8e44-1f2a3b4c5d6e"
 * };
 * const command = new ResumeConversationStreamCommand(input);
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
 * const command = new ResumeConversationStreamCommand(input);
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
export class ResumeConversationStreamCommand extends command<ResumeConversationStreamCommandInput, ResumeConversationStreamCommandOutput>(
  _ep0,
  _mw0,
  "ResumeConversationStream",
  ResumeConversationStream$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ResumeConversationStreamInput;
      output: ResumeConversationStreamOutput;
    };
    sdk: {
      input: ResumeConversationStreamCommandInput;
      output: ResumeConversationStreamCommandOutput;
    };
  };
}
