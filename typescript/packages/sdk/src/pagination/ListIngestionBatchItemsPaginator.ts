// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListIngestionBatchItemsCommand,
  ListIngestionBatchItemsCommandInput,
  ListIngestionBatchItemsCommandOutput,
} from "../commands/ListIngestionBatchItemsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListIngestionBatchItems: (
  config: CaitlynPaginationConfiguration,
  input: ListIngestionBatchItemsCommandInput,
  ...rest: any[]
) => Paginator<ListIngestionBatchItemsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListIngestionBatchItemsCommandInput,
  ListIngestionBatchItemsCommandOutput
>(CaitlynClient, ListIngestionBatchItemsCommand, "cursor", "nextCursor", "limit");
