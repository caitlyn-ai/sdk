// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListDocumentsCommand,
  ListDocumentsCommandInput,
  ListDocumentsCommandOutput,
} from "../commands/ListDocumentsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListDocuments: (
  config: CaitlynPaginationConfiguration,
  input: ListDocumentsCommandInput,
  ...rest: any[]
) => Paginator<ListDocumentsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListDocumentsCommandInput,
  ListDocumentsCommandOutput
>(CaitlynClient, ListDocumentsCommand, "cursor", "nextCursor", "limit");
