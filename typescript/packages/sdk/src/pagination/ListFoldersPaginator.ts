// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import { ListFoldersCommand, ListFoldersCommandInput, ListFoldersCommandOutput } from "../commands/ListFoldersCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListFolders: (
  config: CaitlynPaginationConfiguration,
  input: ListFoldersCommandInput,
  ...rest: any[]
) => Paginator<ListFoldersCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListFoldersCommandInput,
  ListFoldersCommandOutput
>(CaitlynClient, ListFoldersCommand, "cursor", "nextCursor", "limit");
