// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer, StreamingBlobPayloadOutputTypes } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { WatchOperationInput, WatchOperationOutput } from "../models/models_0";
import { WatchOperation$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link WatchOperationCommand}.
 */
export interface WatchOperationCommandInput extends WatchOperationInput {}
/**
 * @public
 *
 * The output of {@link WatchOperationCommand}.
 */
export interface WatchOperationCommandOutput extends Omit<WatchOperationOutput, "events">, __MetadataBearer {
  events: StreamingBlobPayloadOutputTypes;
}

/**
 * Watches an Operation: the whole Operation each time it changes, ending when it is final.
 *
 * The stream sends `operation.updated` on each change and ends with `operation.finished`. With
 * `Last-Event-ID`, a dropped connection resumes without losing a change.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, WatchOperationCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, WatchOperationCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // WatchOperationInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   operationId: "STRING_VALUE", // required
 *   lastEventId: "STRING_VALUE",
 * };
 * const command = new WatchOperationCommand(input);
 * const response = await client.send(command);
 * // consume or destroy the stream to free the socket.
 * const bytes = await response.events.transformToByteArray();
 * // const str = await response.events.transformToString();
 * // response.events.destroy(); // only applicable to Node.js Readable streams.
 *
 * // { // WatchOperationOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   events: "<SdkStream>", // see \@smithy/types -> StreamingBlobPayloadOutputTypes // required
 * // };
 *
 * ```
 *
 * @param WatchOperationCommandInput - {@link WatchOperationCommandInput}
 * @returns {@link WatchOperationCommandOutput}
 * @see {@link WatchOperationCommandInput} for command's `input` shape.
 * @see {@link WatchOperationCommandOutput} for command's `response` shape.
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
 * @example Watch a document's ingestion
 * ```javascript
 * // The events arrive as a stream; the example shows only the request.
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   operationId: "0193a6f2-2222-7b3c-9d4e-5f6071829304"
 * };
 * const command = new WatchOperationCommand(input);
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
 * @example An Operation that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   operationId: "0193a6f2-0000-7000-8000-000000000000"
 * };
 * const command = new WatchOperationCommand(input);
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
export class WatchOperationCommand extends command<WatchOperationCommandInput, WatchOperationCommandOutput>(
  _ep0,
  _mw0,
  "WatchOperation",
  WatchOperation$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: WatchOperationInput;
      output: WatchOperationOutput;
    };
    sdk: {
      input: WatchOperationCommandInput;
      output: WatchOperationCommandOutput;
    };
  };
}
