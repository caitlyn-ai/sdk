// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListFoldersInput, ListFoldersOutput } from "../models/models_0";
import { ListFolders$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListFoldersCommand}.
 */
export interface ListFoldersCommandInput extends ListFoldersInput {}
/**
 * @public
 *
 * The output of {@link ListFoldersCommand}.
 */
export interface ListFoldersCommandOutput extends ListFoldersOutput, __MetadataBearer {}

/**
 * Lists the folders in a knowledge base, one page at a time.
 *
 * Folders come back in a stable order that does not change between pages; the server decides the
 * default order, which is not yet recorded here. With `filter[parent][eq]`, the folders directly in that folder; with `deep` as well, every folder
 * below it. `q` keeps folders whose name contains the text. List the documents in a folder with
 * ListDocuments.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListFoldersCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListFoldersCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListFoldersInput
 *   knowledgeBaseId: "STRING_VALUE", // required
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 *   parent: "STRING_VALUE",
 *   deep: true || false,
 *   q: "STRING_VALUE",
 * };
 * const command = new ListFoldersCommand(input);
 * const response = await client.send(command);
 * // { // ListFoldersOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // FolderList // required
 * //     { // Folder
 * //       path: "STRING_VALUE", // required
 * //       parent: "STRING_VALUE", // required
 * //       name: "STRING_VALUE", // required
 * //       etag: "STRING_VALUE", // required
 * //       readers: { // Readers
 * //         kind: "inherit" || "public" || "everyone" || "specific", // required
 * //         roles: [ // RoleIdList
 * //           "STRING_VALUE",
 * //         ],
 * //         people: [ // UserIdList
 * //           "STRING_VALUE",
 * //         ],
 * //       },
 * //       inheritedFrom: "STRING_VALUE",
 * //       folderCount: Number("long"), // required
 * //       documentCount: Number("long"), // required
 * //       updatedAt: new Date("TIMESTAMP"), // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListFoldersCommandInput - {@link ListFoldersCommandInput}
 * @returns {@link ListFoldersCommandOutput}
 * @see {@link ListFoldersCommandInput} for command's `input` shape.
 * @see {@link ListFoldersCommandOutput} for command's `response` shape.
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
 * @example The folders in the HR folder
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KB4T7YQ2WL",
 *   parent: "/hr/"
 * };
 * const command = new ListFoldersCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       documentCount: 12,
 *       etag: `"folder-3"`,
 *       folderCount: 0,
 *       inheritedFrom: "/hr/",
 *       name: "leave",
 *       parent: "/hr/",
 *       path: "/hr/leave/",
 *       readers: {
 *         kind: "inherit"
 *       },
 *       updatedAt: "2026-11-10T01:04:31.000Z"
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A knowledge base that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   knowledgeBaseId: "KBNOPE0000"
 * };
 * const command = new ListFoldersCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListFoldersCommand extends command<ListFoldersCommandInput, ListFoldersCommandOutput>(
  _ep0,
  _mw0,
  "ListFolders",
  ListFolders$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListFoldersInput;
      output: ListFoldersOutput;
    };
    sdk: {
      input: ListFoldersCommandInput;
      output: ListFoldersCommandOutput;
    };
  };
}
