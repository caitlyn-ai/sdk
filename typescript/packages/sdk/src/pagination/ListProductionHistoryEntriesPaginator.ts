// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListProductionHistoryEntriesCommand,
  ListProductionHistoryEntriesCommandInput,
  ListProductionHistoryEntriesCommandOutput,
} from "../commands/ListProductionHistoryEntriesCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListProductionHistoryEntries: (
  config: CaitlynPaginationConfiguration,
  input: ListProductionHistoryEntriesCommandInput,
  ...rest: any[]
) => Paginator<ListProductionHistoryEntriesCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListProductionHistoryEntriesCommandInput,
  ListProductionHistoryEntriesCommandOutput
>(CaitlynClient, ListProductionHistoryEntriesCommand, "cursor", "nextCursor", "limit");
