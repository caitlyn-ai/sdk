// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListDocumentVersionsCommand,
  ListDocumentVersionsCommandInput,
  ListDocumentVersionsCommandOutput,
} from "../commands/ListDocumentVersionsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListDocumentVersions: (
  config: CaitlynPaginationConfiguration,
  input: ListDocumentVersionsCommandInput,
  ...rest: any[]
) => Paginator<ListDocumentVersionsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListDocumentVersionsCommandInput,
  ListDocumentVersionsCommandOutput
>(CaitlynClient, ListDocumentVersionsCommand, "cursor", "nextCursor", "limit");
