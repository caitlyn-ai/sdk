// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListConversationsCommand,
  ListConversationsCommandInput,
  ListConversationsCommandOutput,
} from "../commands/ListConversationsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListConversations: (
  config: CaitlynPaginationConfiguration,
  input: ListConversationsCommandInput,
  ...rest: any[]
) => Paginator<ListConversationsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListConversationsCommandInput,
  ListConversationsCommandOutput
>(CaitlynClient, ListConversationsCommand, "cursor", "nextCursor", "limit");
