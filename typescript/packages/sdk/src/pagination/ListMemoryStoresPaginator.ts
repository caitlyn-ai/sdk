// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListMemoryStoresCommand,
  ListMemoryStoresCommandInput,
  ListMemoryStoresCommandOutput,
} from "../commands/ListMemoryStoresCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListMemoryStores: (
  config: CaitlynPaginationConfiguration,
  input: ListMemoryStoresCommandInput,
  ...rest: any[]
) => Paginator<ListMemoryStoresCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListMemoryStoresCommandInput,
  ListMemoryStoresCommandOutput
>(CaitlynClient, ListMemoryStoresCommand, "cursor", "nextCursor", "limit");
