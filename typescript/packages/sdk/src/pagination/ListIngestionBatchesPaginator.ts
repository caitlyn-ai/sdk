// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListIngestionBatchesCommand,
  ListIngestionBatchesCommandInput,
  ListIngestionBatchesCommandOutput,
} from "../commands/ListIngestionBatchesCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListIngestionBatches: (
  config: CaitlynPaginationConfiguration,
  input: ListIngestionBatchesCommandInput,
  ...rest: any[]
) => Paginator<ListIngestionBatchesCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListIngestionBatchesCommandInput,
  ListIngestionBatchesCommandOutput
>(CaitlynClient, ListIngestionBatchesCommand, "cursor", "nextCursor", "limit");
