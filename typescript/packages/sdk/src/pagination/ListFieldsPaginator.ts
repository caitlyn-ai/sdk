// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import { ListFieldsCommand, ListFieldsCommandInput, ListFieldsCommandOutput } from "../commands/ListFieldsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListFields: (
  config: CaitlynPaginationConfiguration,
  input: ListFieldsCommandInput,
  ...rest: any[]
) => Paginator<ListFieldsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListFieldsCommandInput,
  ListFieldsCommandOutput
>(CaitlynClient, ListFieldsCommand, "cursor", "nextCursor", "limit");
