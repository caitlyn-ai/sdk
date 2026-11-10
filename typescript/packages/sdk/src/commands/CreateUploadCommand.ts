// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { CreateUploadInput, CreateUploadOutput } from "../models/models_0";
import { CreateUpload$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link CreateUploadCommand}.
 */
export interface CreateUploadCommandInput extends CreateUploadInput {}
/**
 * @public
 *
 * The output of {@link CreateUploadCommand}.
 */
export interface CreateUploadCommandOutput extends CreateUploadOutput, __MetadataBearer {}

/**
 * Reserves a short-lived slot for a file's bytes and returns a presigned URL bound to their
 * checksum.
 *
 * Send the bytes with `uploadMethod` to `uploadUrl`, with every header in `requiredHeaders`,
 * before `expiresAt`; then pass the upload's `id` to the operation that uses it. The SDKs'
 * `uploads.create(file)` does all of this.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, CreateUploadCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, CreateUploadCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // CreateUploadInput
 *   idempotencyKey: "STRING_VALUE",
 *   fileName: "STRING_VALUE", // required
 *   contentType: "STRING_VALUE", // required
 *   byteSize: Number("long"), // required
 *   sha256: "STRING_VALUE", // required
 * };
 * const command = new CreateUploadCommand(input);
 * const response = await client.send(command);
 * // { // CreateUploadOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   location: "STRING_VALUE",
 * //   id: "STRING_VALUE", // required
 * //   uploadUrl: "STRING_VALUE", // required
 * //   uploadMethod: "STRING_VALUE", // required
 * //   requiredHeaders: { // HeaderMap // required
 * //     "<keys>": "STRING_VALUE",
 * //   },
 * //   expiresAt: new Date("TIMESTAMP"), // required
 * //   status: "awaiting_bytes" || "received" || "consumed" || "expired", // required
 * // };
 *
 * ```
 *
 * @param CreateUploadCommandInput - {@link CreateUploadCommandInput}
 * @returns {@link CreateUploadCommandOutput}
 * @see {@link CreateUploadCommandInput} for command's `input` shape.
 * @see {@link CreateUploadCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress.
 *
 * @throws {@link PayloadTooLargeError} (client fault)
 *  The body, a file or the send `context` is over its documented limit.
 *
 * @throws {@link UnprocessableContentError} (client fault)
 *  The idempotency key was already used with a different request body.
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
 * @example Reserve an upload for a PDF
 * ```javascript
 * //
 * const input = {
 *   byteSize: 482113,
 *   contentType: "application/pdf",
 *   fileName: "leave-policy.pdf",
 *   idempotencyKey: "9b1d4e2a-7c3f-4a8e-b5d6-0e1f2a3b4c5d",
 *   sha256: "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="
 * };
 * const command = new CreateUploadCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   expiresAt: "2026-11-10T01:17:03.000Z",
 *   id: "0193a6f2-1111-7a2b-8c3d-4e5f60718293",
 *   location: "/api/v3/uploads/0193a6f2-1111-7a2b-8c3d-4e5f60718293",
 *   requiredHeaders: {
 *     Content-Type: "application/pdf"
 *   },
 *   status: "awaiting_bytes",
 *   uploadMethod: "PUT",
 *   uploadUrl: "https://uploads.example.com/0193a6f2-1111-7a2b-8c3d-4e5f60718293?signature=abc"
 * }
 * *\/
 * ```
 *
 * @example A file over the size limit
 * ```javascript
 * //
 * const input = {
 *   byteSize: 9000000000,
 *   contentType: "application/zip",
 *   fileName: "archive.zip",
 *   sha256: "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="
 * };
 * const command = new CreateUploadCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class CreateUploadCommand extends command<CreateUploadCommandInput, CreateUploadCommandOutput>(
  _ep0,
  _mw0,
  "CreateUpload",
  CreateUpload$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: CreateUploadInput;
      output: CreateUploadOutput;
    };
    sdk: {
      input: CreateUploadCommandInput;
      output: CreateUploadCommandOutput;
    };
  };
}
