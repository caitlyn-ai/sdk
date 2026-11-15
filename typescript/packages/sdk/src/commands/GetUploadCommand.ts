// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetUploadInput, GetUploadOutput } from "../models/models_0";
import { GetUpload$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetUploadCommand}.
 */
export interface GetUploadCommandInput extends GetUploadInput {}
/**
 * @public
 *
 * The output of {@link GetUploadCommand}.
 */
export interface GetUploadCommandOutput extends GetUploadOutput, __MetadataBearer {}

/**
 * Gets an upload's status and when its upload URL expires.
 *
 * Use it to check that the bytes arrived before passing the upload's `id` to the operation that
 * uses it. Only the person or client that reserved the upload can read it; anyone else gets 404.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetUploadCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetUploadCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetUploadInput
 *   uploadId: "STRING_VALUE", // required
 * };
 * const command = new GetUploadCommand(input);
 * const response = await client.send(command);
 * // { // GetUploadOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   id: "STRING_VALUE", // required
 * //   status: "awaiting_bytes" || "received" || "consumed" || "expired", // required
 * //   expiresAt: new Date("TIMESTAMP"), // required
 * // };
 *
 * ```
 *
 * @param GetUploadCommandInput - {@link GetUploadCommandInput}
 * @returns {@link GetUploadCommandOutput}
 * @see {@link GetUploadCommandInput} for command's `input` shape.
 * @see {@link GetUploadCommandOutput} for command's `response` shape.
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
 * @example An upload whose bytes have arrived
 * ```javascript
 * //
 * const input = {
 *   uploadId: "0193a6f2-1111-7a2b-8c3d-4e5f60718293"
 * };
 * const command = new GetUploadCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   expiresAt: "2026-11-10T01:17:03.000Z",
 *   id: "0193a6f2-1111-7a2b-8c3d-4e5f60718293",
 *   status: "received"
 * }
 * *\/
 * ```
 *
 * @example An upload that does not exist, or that someone else reserved
 * ```javascript
 * //
 * const input = {
 *   uploadId: "0193a6f2-0000-7000-8000-000000000000"
 * };
 * const command = new GetUploadCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetUploadCommand extends command<GetUploadCommandInput, GetUploadCommandOutput>(
  _ep0,
  _mw0,
  "GetUpload",
  GetUpload$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetUploadInput;
      output: GetUploadOutput;
    };
    sdk: {
      input: GetUploadCommandInput;
      output: GetUploadCommandOutput;
    };
  };
}
