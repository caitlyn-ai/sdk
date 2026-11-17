// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import { ListModelsCommand, ListModelsCommandInput, ListModelsCommandOutput } from "../commands/ListModelsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListModels: (
  config: CaitlynPaginationConfiguration,
  input: ListModelsCommandInput,
  ...rest: any[]
) => Paginator<ListModelsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListModelsCommandInput,
  ListModelsCommandOutput
>(CaitlynClient, ListModelsCommand, "cursor", "nextCursor", "limit");
