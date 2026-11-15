// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListAgentVersionsCommand,
  ListAgentVersionsCommandInput,
  ListAgentVersionsCommandOutput,
} from "../commands/ListAgentVersionsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListAgentVersions: (
  config: CaitlynPaginationConfiguration,
  input: ListAgentVersionsCommandInput,
  ...rest: any[]
) => Paginator<ListAgentVersionsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListAgentVersionsCommandInput,
  ListAgentVersionsCommandOutput
>(CaitlynClient, ListAgentVersionsCommand, "cursor", "nextCursor", "limit");
