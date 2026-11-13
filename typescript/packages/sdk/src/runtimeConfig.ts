// smithy-typescript generated code
import { emitWarningIfUnsupportedVersion } from "@smithy/core/client";
import { calculateBodyLength } from "@smithy/core/serde";
import { FetchHttpHandler as RequestHandler, streamCollector } from "@smithy/fetch-http-handler";

import type { CaitlynClientConfig } from "./CaitlynClient";
import { getRuntimeConfig as getSharedRuntimeConfig } from "./runtimeConfig.shared";

/**
 * @internal
 */
export const getRuntimeConfig = (config: CaitlynClientConfig) => {
  emitWarningIfUnsupportedVersion(process.version);
  const clientSharedValues = getSharedRuntimeConfig(config);
  return {
    ...clientSharedValues,
    ...config,
    runtime: "node",
    bodyLengthChecker: config?.bodyLengthChecker ?? calculateBodyLength,
    maxAttempts: config?.maxAttempts ?? 3,
    requestHandler: RequestHandler.create(config?.requestHandler ?? (async () => undefined)),
    retryMode:
      config?.retryMode ??
    "standard",
    streamCollector: config?.streamCollector ?? streamCollector,
  };
};
