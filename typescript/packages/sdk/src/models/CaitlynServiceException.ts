// smithy-typescript generated code
import {
  type ServiceExceptionOptions as __ServiceExceptionOptions,
  ServiceException as __ServiceException,
} from "@smithy/core/client";

export type { __ServiceExceptionOptions };

export { __ServiceException };

/**
 * @public
 *
 * Base exception class for all service exceptions from Caitlyn service.
 */
export class CaitlynServiceException extends __ServiceException {
  public static readonly shapeId: string = "smithy.ts.sdk.synthetic.ai.caitlyn.v3#CaitlynServiceException";
  /**
   * @internal
   */
  constructor(options: __ServiceExceptionOptions) {
    super(options);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
