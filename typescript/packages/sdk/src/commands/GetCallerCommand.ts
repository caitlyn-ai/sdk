// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetCallerInput, GetCallerOutput } from "../models/models_0";
import { GetCaller$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetCallerCommand}.
 */
export interface GetCallerCommandInput extends GetCallerInput {}
/**
 * @public
 *
 * The output of {@link GetCallerCommand}.
 */
export interface GetCallerCommandOutput extends GetCallerOutput, __MetadataBearer {}

/**
 * Describes the caller: who the credential belongs to, what kind of credential it is, its scopes
 * and its organisation.
 *
 * Any valid credential may call it, with no particular scope, so an integration can check its
 * credential before doing anything else. It only describes the credential that made the request;
 * it never reads another person's or client's record.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetCallerCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetCallerCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = {};
 * const command = new GetCallerCommand(input);
 * const response = await client.send(command);
 * // { // GetCallerOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   userId: "STRING_VALUE",
 * //   apiClientId: "STRING_VALUE",
 * //   displayName: "STRING_VALUE", // required
 * //   credential: "browser" || "personal" || "oauth" || "api_client", // required
 * //   scopes: [ // OAuthScopeList // required
 * //     "STRING_VALUE",
 * //   ],
 * //   organisation: { // OrganisationSummary
 * //     id: "STRING_VALUE", // required
 * //     name: "STRING_VALUE", // required
 * //   },
 * // };
 *
 * ```
 *
 * @param GetCallerCommandInput - {@link GetCallerCommandInput}
 * @returns {@link GetCallerCommandOutput}
 * @see {@link GetCallerCommandInput} for command's `input` shape.
 * @see {@link GetCallerCommandOutput} for command's `response` shape.
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
 * @example A person calling with a personal access token
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new GetCallerCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   credential: "personal",
 *   displayName: "Aroha Ngata",
 *   organisation: {
 *     id: "org-harbour-freight",
 *     name: "Harbour Freight"
 *   },
 *   scopes: [
 *     "agents:read",
 *     "knowledge-bases:write"
 *   ],
 *   userId: "3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64"
 * }
 * *\/
 * ```
 *
 * @example An API client
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new GetCallerCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   apiClientId: "cl_7Qm2xR9vK4",
 *   credential: "api_client",
 *   displayName: "Nightly policy sync",
 *   organisation: {
 *     id: "org-harbour-freight",
 *     name: "Harbour Freight"
 *   },
 *   scopes: [
 *     "files:write"
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A credential that has expired or been revoked
 * ```javascript
 * //
 * const input = { /* empty *\/ };
 * const command = new GetCallerCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetCallerCommand extends command<GetCallerCommandInput, GetCallerCommandOutput>(
  _ep0,
  _mw0,
  "GetCaller",
  GetCaller$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: {};
      output: GetCallerOutput;
    };
    sdk: {
      input: GetCallerCommandInput;
      output: GetCallerCommandOutput;
    };
  };
}
