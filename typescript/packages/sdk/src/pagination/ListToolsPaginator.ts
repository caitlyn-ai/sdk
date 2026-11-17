// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import { ListToolsCommand, ListToolsCommandInput, ListToolsCommandOutput } from "../commands/ListToolsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListTools: (
  config: CaitlynPaginationConfiguration,
  input: ListToolsCommandInput,
  ...rest: any[]
) => Paginator<ListToolsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListToolsCommandInput,
  ListToolsCommandOutput
>(CaitlynClient, ListToolsCommand, "cursor", "nextCursor", "limit");
