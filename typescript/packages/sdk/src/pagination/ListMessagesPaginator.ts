// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListMessagesCommand,
  ListMessagesCommandInput,
  ListMessagesCommandOutput,
} from "../commands/ListMessagesCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListMessages: (
  config: CaitlynPaginationConfiguration,
  input: ListMessagesCommandInput,
  ...rest: any[]
) => Paginator<ListMessagesCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListMessagesCommandInput,
  ListMessagesCommandOutput
>(CaitlynClient, ListMessagesCommand, "cursor", "nextCursor", "limit");
