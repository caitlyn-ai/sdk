// smithy-typescript generated code
import type { ExceptionOptionType as __ExceptionOptionType } from "@smithy/core/client";

import { CaitlynServiceException as __BaseException } from "./CaitlynServiceException";
import type { FieldError } from "./models_0";

/**
 * An unexpected server failure. Not retried by the SDKs.
 * @public
 */
export class InternalError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#InternalError";
  readonly name = "InternalError" as const;
  readonly $fault = "server" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<InternalError, __BaseException>) {
    super({
      name: "InternalError",
      $fault: "server",
      ...opts,
    });
    Object.setPrototypeOf(this, InternalError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 * @public
 */
export class NotFoundError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#NotFoundError";
  readonly name = "NotFoundError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<NotFoundError, __BaseException>) {
    super({
      name: "NotFoundError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, NotFoundError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * The caller may not call this operation: it lacks the permission, its credential type may not
 * call it, or the operation is served only on the organisation's primary workspace. Decided before
 * any record is read. A record the caller may not see is 404 instead.
 * @public
 */
export class PermissionDeniedError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#PermissionDeniedError";
  readonly name = "PermissionDeniedError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<PermissionDeniedError, __BaseException>) {
    super({
      name: "PermissionDeniedError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, PermissionDeniedError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * `If-Match` does not match the resource's current ETag: it changed since the caller read it.
 * @public
 */
export class PreconditionFailedError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#PreconditionFailedError";
  readonly name = "PreconditionFailedError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<PreconditionFailedError, __BaseException>) {
    super({
      name: "PreconditionFailedError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, PreconditionFailedError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * The update sent no `If-Match` header; read the resource and send its ETag.
 * @public
 */
export class PreconditionRequiredError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#PreconditionRequiredError";
  readonly name = "PreconditionRequiredError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<PreconditionRequiredError, __BaseException>) {
    super({
      name: "PreconditionRequiredError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, PreconditionRequiredError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * A dependency is briefly unavailable, or the request's audit event could not be recorded; wait for
 * `Retry-After` and try again.
 * @public
 */
export class ServiceUnavailableError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#ServiceUnavailableError";
  readonly name = "ServiceUnavailableError" as const;
  readonly $fault = "server" as const;
  $retryable = {};
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;

  /**
   * Seconds to wait before trying again, from the `Retry-After` header.
   * @public
   */
  retryAfterSeconds?: number | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<ServiceUnavailableError, __BaseException>) {
    super({
      name: "ServiceUnavailableError",
      $fault: "server",
      ...opts,
    });
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/**
 * Too many requests; wait for `Retry-After` and try again.
 * @public
 */
export class TooManyRequestsError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#TooManyRequestsError";
  readonly name = "TooManyRequestsError" as const;
  readonly $fault = "client" as const;
  $retryable = {
    throttling: true,
  };
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;

  /**
   * Seconds to wait before trying again, from the `Retry-After` header.
   * @public
   */
  retryAfterSeconds?: number | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<TooManyRequestsError, __BaseException>) {
    super({
      name: "TooManyRequestsError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, TooManyRequestsError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/**
 * No credential was sent, or it is expired or not valid.
 * @public
 */
export class UnauthenticatedError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#UnauthenticatedError";
  readonly name = "UnauthenticatedError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<UnauthenticatedError, __BaseException>) {
    super({
      name: "UnauthenticatedError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, UnauthenticatedError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * The request is malformed: a member is missing, the wrong type or out of range; it has a member,
 * filter or sort field the operation does not define; or its cursor is not valid for this list.
 * @public
 */
export class ValidationError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#ValidationError";
  readonly name = "ValidationError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<ValidationError, __BaseException>) {
    super({
      name: "ValidationError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, ValidationError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress.
 * @public
 */
export class ConflictError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#ConflictError";
  readonly name = "ConflictError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<ConflictError, __BaseException>) {
    super({
      name: "ConflictError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, ConflictError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * The body, a file or the send `context` is over its documented limit.
 * @public
 */
export class PayloadTooLargeError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#PayloadTooLargeError";
  readonly name = "PayloadTooLargeError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<PayloadTooLargeError, __BaseException>) {
    super({
      name: "PayloadTooLargeError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, PayloadTooLargeError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * The idempotency key was already used with a different request body.
 * @public
 */
export class UnprocessableContentError extends __BaseException {
  public static readonly shapeId: string = "ai.caitlyn.v3#UnprocessableContentError";
  readonly name = "UnprocessableContentError" as const;
  readonly $fault = "client" as const;
  /**
   * A stable URI for the code: its page in the public error reference,
   * `https://build.caitlyn.ai/errors/\{code\}`.
   * @public
   */
  type: string;

  /**
   * A short, human-readable summary of the problem, the same for every occurrence of the code.
   * @public
   */
  title: string;

  /**
   * The HTTP status code, repeated from the response.
   * @public
   */
  status: number;

  /**
   * The stable code, for example `NOT_FOUND`. Once shipped a code keeps its meaning and is never
   * renamed; callers match on it.
   * @public
   */
  code: string;

  /**
   * What went wrong in this occurrence, written for the integrator. Never holds stack traces,
   * storage keys or another person's data.
   * @public
   */
  detail?: string | undefined;

  /**
   * The request's identifier, the same value as the `Caitlyn-Request-Id` header. Quote it to
   * support.
   * @public
   */
  requestId: string;

  /**
   * Field-level problems, one per member or parameter at fault. Present only on 400
   * `VALIDATION_FAILED`.
   * @public
   */
  errors?: FieldError[] | undefined;
  /**
   * @internal
   */
  constructor(opts: __ExceptionOptionType<UnprocessableContentError, __BaseException>) {
    super({
      name: "UnprocessableContentError",
      $fault: "client",
      ...opts,
    });
    Object.setPrototypeOf(this, UnprocessableContentError.prototype);
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}
