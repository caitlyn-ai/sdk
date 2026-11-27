// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetAccessInput, GetAccessOutput } from "../models/models_0";
import { GetAccess$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetAccessCommand}.
 */
export interface GetAccessCommandInput extends GetAccessInput {}
/**
 * @public
 *
 * The output of {@link GetAccessCommand}.
 */
export interface GetAccessCommandOutput extends GetAccessOutput, __MetadataBearer {}

/**
 * Gets who may use a knowledge base, or who may read a folder or a document in it.
 *
 * Without `folder` or `document`, the knowledge base's role grants (`roles`). With `folder`, that
 * folder's `readers`; with `document`, that document's. `inheritedFrom` names the folder whose readers
 * apply when they are inherited. A folder or document the caller may not see is 404. The root
 * folder (`folder=/`, `kb.folders('/').access`) holds the readers every folder falls back to; its
 * readers are never inherited.
 *
 * For a folder or document, the `readers` also come back on ListFolders, ListDocuments and
 * GetDocument too, with `inheritedFrom`, under the files list and read permissions. What GetAccess
 * adds is the access on its own, with the ETag that SetAccess's `If-Match` takes, and the root
 * folder's readers; reading it needs the files permissions list permission.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetAccessCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetAccessCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetAccessInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   folder: "STRING_VALUE",
 *   document: "STRING_VALUE",
 * };
 * const command = new GetAccessCommand(input);
 * const response = await client.send(command);
 * // { // GetAccessOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   access: { // Access
 * //     roles: [ // RoleAccessList
 * //       { // RoleAccess
 * //         roleId: "STRING_VALUE", // required
 * //         name: "STRING_VALUE",
 * //         can: [ // AccessActionList // required
 * //           "find" || "read" || "edit" || "delete",
 * //         ],
 * //       },
 * //     ],
 * //     readers: { // Readers
 * //       kind: "inherit" || "public" || "everyone" || "specific", // required
 * //       roles: [ // RoleIdList
 * //         "STRING_VALUE",
 * //       ],
 * //       people: [ // UserIdList
 * //         "STRING_VALUE",
 * //       ],
 * //     },
 * //     etag: "STRING_VALUE", // required
 * //     inheritedFrom: "STRING_VALUE",
 * //   },
 * // };
 *
 * ```
 *
 * @param GetAccessCommandInput - {@link GetAccessCommandInput}
 * @returns {@link GetAccessCommandOutput}
 * @see {@link GetAccessCommandInput} for command's `input` shape.
 * @see {@link GetAccessCommandOutput} for command's `response` shape.
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
 * @example The roles that may use a knowledge base
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetAccessCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   access: {
 *     etag: `"4"`,
 *     roles: [
 *       {
 *         can: [
 *           "find",
 *           "read",
 *           "edit"
 *         ],
 *         name: "HR team",
 *         roleId: "hr-team"
 *       },
 *       {
 *         can: [
 *           "find",
 *           "read"
 *         ],
 *         name: "Staff",
 *         roleId: "staff"
 *       }
 *     ]
 *   },
 *   etag: `"4"`
 * }
 * *\/
 * ```
 *
 * @example Who may read a folder
 * ```javascript
 * //
 * const input = {
 *   folder: "/hr/investigations/",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetAccessCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   access: {
 *     etag: `"2"`,
 *     readers: {
 *       kind: "specific",
 *       roles: [
 *         "hr-team"
 *       ]
 *     }
 *   },
 *   etag: `"2"`
 * }
 * *\/
 * ```
 *
 * @example A folder named permissions is just a folder
 * ```javascript
 * //
 * const input = {
 *   folder: "/legal/permissions/",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetAccessCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   access: {
 *     etag: `"1"`,
 *     inheritedFrom: "/legal/",
 *     readers: {
 *       kind: "inherit"
 *     }
 *   },
 *   etag: `"1"`
 * }
 * *\/
 * ```
 *
 * @example A folder that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   folder: "/nope/",
 *   knowledgeBaseId: "KB4T7YQ2WL"
 * };
 * const command = new GetAccessCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetAccessCommand extends command<GetAccessCommandInput, GetAccessCommandOutput>(
  _ep0,
  _mw0,
  "GetAccess",
  GetAccess$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetAccessInput;
      output: GetAccessOutput;
    };
    sdk: {
      input: GetAccessCommandInput;
      output: GetAccessCommandOutput;
    };
  };
}
