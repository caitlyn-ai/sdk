// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import { ListAgentsCommand, ListAgentsCommandInput, ListAgentsCommandOutput } from "../commands/ListAgentsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListAgents: (
  config: CaitlynPaginationConfiguration,
  input: ListAgentsCommandInput,
  ...rest: any[]
) => Paginator<ListAgentsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListAgentsCommandInput,
  ListAgentsCommandOutput
>(CaitlynClient, ListAgentsCommand, "cursor", "nextCursor", "limit");
