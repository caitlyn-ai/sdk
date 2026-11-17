// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { PutAccessInput, PutAccessOutput } from "../models/models_0";
import { PutAccess$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link PutAccessCommand}.
 */
export interface PutAccessCommandInput extends PutAccessInput {}
/**
 * @public
 *
 * The output of {@link PutAccessCommand}.
 */
export interface PutAccessCommandOutput extends PutAccessOutput, __MetadataBearer {}

/**
 * Sets who may use a knowledge base, or who may read a folder or a document in it.
 *
 * `If-Match` is optional. Without it the write is unconditional and the last writer wins, which is
 * safe because the caller sends the whole list. With it, access that changed since is refused with
 * 412.
 *
 * Without `folder` or `document`, send `roles`: the roles sent become the whole list. With `folder` or
 * `document`, send `readers`; `kind: inherit` makes it follow its folder again. The knowledge base's
 * role grants are set only without a target, under the knowledge base's own permission, as v2's
 * knowledge base permissions route sets them, so `roles` with `folder` or `document`, `readers`
 * without one, and both `folder` and `document` are refused with 400 `VALIDATION_FAILED`. The root folder
 * (`folder=/`) holds the readers every other folder falls back to, so `inherit` is refused there
 * with 400 `VALIDATION_FAILED`. Applying readers to
 * the passages a folder or document holds continues after the response; the returned access says
 * what is set, and the knowledge base's watch shows the work.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, PutAccessCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, PutAccessCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // PutAccessInput
 *   roles: [ // RoleAccessList
 *     { // RoleAccess
 *       roleId: "STRING_VALUE", // required
 *       name: "STRING_VALUE",
 *       can: [ // AccessActionList // required
 *         "find" || "read" || "edit" || "delete",
 *       ],
 *     },
 *   ],
 *   readers: { // Readers
 *     kind: "inherit" || "public" || "everyone" || "specific", // required
 *     roles: [ // RoleIdList
 *       "STRING_VALUE",
 *     ],
 *     people: [ // UserIdList
 *       "STRING_VALUE",
 *     ],
 *   },
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   folder: "STRING_VALUE",
 *   document: "STRING_VALUE",
 *   ifMatch: "STRING_VALUE",
 * };
 * const command = new PutAccessCommand(input);
 * const response = await client.send(command);
 * // { // PutAccessOutput
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
 * @param PutAccessCommandInput - {@link PutAccessCommandInput}
 * @returns {@link PutAccessCommandOutput}
 * @see {@link PutAccessCommandInput} for command's `input` shape.
 * @see {@link PutAccessCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link PreconditionFailedError} (client fault)
 *  `If-Match` does not match the resource's current ETag: it changed since the caller read it.
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
 * @example Only the HR team may read investigations
 * ```javascript
 * //
 * const input = {
 *   folder: "/hr/investigations/",
 *   ifMatch: `"2"`,
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   readers: {
 *     kind: "specific",
 *     roles: [
 *       "hr-team"
 *     ]
 *   }
 * };
 * const command = new PutAccessCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   access: {
 *     etag: `"3"`,
 *     readers: {
 *       kind: "specific",
 *       roles: [
 *         "hr-team"
 *       ]
 *     }
 *   },
 *   etag: `"3"`
 * }
 * *\/
 * ```
 *
 * @example A document follows its folder again, whatever its access was
 * ```javascript
 * // Without If-Match the write is unconditional: the last writer wins.
 * const input = {
 *   document: "doc-3b7f9e21",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   readers: {
 *     kind: "inherit"
 *   }
 * };
 * const command = new PutAccessCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   access: {
 *     etag: `"2"`,
 *     inheritedFrom: "/hr/",
 *     readers: {
 *       kind: "inherit"
 *     }
 *   },
 *   etag: `"2"`
 * }
 * *\/
 * ```
 *
 * @example Role grants sent with a folder
 * ```javascript
 * //
 * const input = {
 *   folder: "/hr/",
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   roles: [
 *     {
 *       can: [
 *         "find",
 *         "read"
 *       ],
 *       roleId: "hr-team"
 *     }
 *   ]
 * };
 * const command = new PutAccessCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @example The access changed since it was read
 * ```javascript
 * //
 * const input = {
 *   ifMatch: `"3"`,
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   roles:   []
 * };
 * const command = new PutAccessCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class PutAccessCommand extends command<PutAccessCommandInput, PutAccessCommandOutput>(
  _ep0,
  _mw0,
  "PutAccess",
  PutAccess$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: PutAccessInput;
      output: PutAccessOutput;
    };
    sdk: {
      input: PutAccessCommandInput;
      output: PutAccessCommandOutput;
    };
  };
}
