// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import { ListVoicesCommand, ListVoicesCommandInput, ListVoicesCommandOutput } from "../commands/ListVoicesCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListVoices: (
  config: CaitlynPaginationConfiguration,
  input: ListVoicesCommandInput,
  ...rest: any[]
) => Paginator<ListVoicesCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListVoicesCommandInput,
  ListVoicesCommandOutput
>(CaitlynClient, ListVoicesCommand, "cursor", "nextCursor", "limit");
