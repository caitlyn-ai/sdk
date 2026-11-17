// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListHistoryEntriesCommand,
  ListHistoryEntriesCommandInput,
  ListHistoryEntriesCommandOutput,
} from "../commands/ListHistoryEntriesCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListHistoryEntries: (
  config: CaitlynPaginationConfiguration,
  input: ListHistoryEntriesCommandInput,
  ...rest: any[]
) => Paginator<ListHistoryEntriesCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListHistoryEntriesCommandInput,
  ListHistoryEntriesCommandOutput
>(CaitlynClient, ListHistoryEntriesCommand, "cursor", "nextCursor", "limit");
