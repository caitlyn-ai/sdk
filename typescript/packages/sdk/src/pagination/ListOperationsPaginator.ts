// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListOperationsCommand,
  ListOperationsCommandInput,
  ListOperationsCommandOutput,
} from "../commands/ListOperationsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListOperations: (
  config: CaitlynPaginationConfiguration,
  input: ListOperationsCommandInput,
  ...rest: any[]
) => Paginator<ListOperationsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListOperationsCommandInput,
  ListOperationsCommandOutput
>(CaitlynClient, ListOperationsCommand, "cursor", "nextCursor", "limit");
