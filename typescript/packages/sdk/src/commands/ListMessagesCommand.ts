// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { ListMessagesInput, ListMessagesOutput } from "../models/models_0";
import { ListMessages$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link ListMessagesCommand}.
 */
export interface ListMessagesCommandInput extends ListMessagesInput {}
/**
 * @public
 *
 * The output of {@link ListMessagesCommand}.
 */
export interface ListMessagesCommandOutput extends ListMessagesOutput, __MetadataBearer {}

/**
 * Lists a conversation's messages, oldest first: the caller's and the agent's.
 *
 * An answer still being written is not listed until it ends; follow it with WatchConversation.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, ListMessagesCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, ListMessagesCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // ListMessagesInput
 *   conversationId: "STRING_VALUE", // required
 *   limit: Number("int"),
 *   cursor: "STRING_VALUE",
 * };
 * const command = new ListMessagesCommand(input);
 * const response = await client.send(command);
 * // { // ListMessagesOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   items: [ // MessageList // required
 * //     { // Message
 * //       id: "STRING_VALUE", // required
 * //       role: "user" || "assistant", // required
 * //       text: "STRING_VALUE", // required
 * //       agentVersion: "STRING_VALUE",
 * //       citations: [ // CitationList
 * //         { // Citation
 * //           number: Number("int"), // required
 * //           documentId: "STRING_VALUE",
 * //           knowledgeBaseId: "STRING_VALUE",
 * //           documentName: "STRING_VALUE",
 * //           pageNumber: Number("int"),
 * //         },
 * //       ],
 * //       attachments: [ // MessageAttachmentList
 * //         { // MessageAttachment
 * //           name: "STRING_VALUE", // required
 * //           contentType: "STRING_VALUE", // required
 * //           byteSize: Number("long"), // required
 * //         },
 * //       ],
 * //       createdAt: new Date("TIMESTAMP"), // required
 * //     },
 * //   ],
 * //   nextCursor: "STRING_VALUE",
 * // };
 *
 * ```
 *
 * @param ListMessagesCommandInput - {@link ListMessagesCommandInput}
 * @returns {@link ListMessagesCommandOutput}
 * @see {@link ListMessagesCommandInput} for command's `input` shape.
 * @see {@link ListMessagesCommandOutput} for command's `response` shape.
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
 * @example A question and its answer
 * ```javascript
 * //
 * const input = {
 *   conversationId: "0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47"
 * };
 * const command = new ListMessagesCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   items: [
 *     {
 *       createdAt: "2026-11-13T01:02:10.000Z",
 *       id: "0193a6f2-8a10-7b2c-9d3e-4f5061728394",
 *       role: "user",
 *       text: "How much annual leave do part-time staff get?"
 *     },
 *     {
 *       agentVersion: "november-release",
 *       createdAt: "2026-11-13T01:02:31.000Z",
 *       id: "0193a6f2-8a11-7b2c-9d3e-4f5061728395",
 *       role: "assistant",
 *       text: "Part-time staff get four weeks a year, pro rata."
 *     }
 *   ]
 * }
 * *\/
 * ```
 *
 * @example A conversation that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   conversationId: "0193a6f2-0000-7000-8000-000000000000"
 * };
 * const command = new ListMessagesCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class ListMessagesCommand extends command<ListMessagesCommandInput, ListMessagesCommandOutput>(
  _ep0,
  _mw0,
  "ListMessages",
  ListMessages$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: ListMessagesInput;
      output: ListMessagesOutput;
    };
    sdk: {
      input: ListMessagesCommandInput;
      output: ListMessagesCommandOutput;
    };
  };
}
