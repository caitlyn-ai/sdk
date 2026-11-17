// smithy-typescript generated code
import { createPaginator } from "@smithy/core";
import type { Paginator } from "@smithy/types";

import { CaitlynClient } from "../CaitlynClient";
import {
  ListGuardrailsCommand,
  ListGuardrailsCommandInput,
  ListGuardrailsCommandOutput,
} from "../commands/ListGuardrailsCommand";
import type { CaitlynPaginationConfiguration } from "./Interfaces";

/**
 * @public
 */
export const paginateListGuardrails: (
  config: CaitlynPaginationConfiguration,
  input: ListGuardrailsCommandInput,
  ...rest: any[]
) => Paginator<ListGuardrailsCommandOutput> = createPaginator<
  CaitlynPaginationConfiguration,
  ListGuardrailsCommandInput,
  ListGuardrailsCommandOutput
>(CaitlynClient, ListGuardrailsCommand, "cursor", "nextCursor", "limit");
