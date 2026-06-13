/**
 * Error contract. The body shape is documented in docs/ERRORS.md and parsed by
 * `@parserelay/client`'s `ParseRelayError`.
 */
export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "payment_required"
  | "not_found"
  | "rate_limited"
  | "engine_error"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  payment_required: 402,
  not_found: 404,
  rate_limited: 429,
  engine_error: 502,
  internal: 500,
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/** A thrown error that maps to a stable HTTP status + JSON body. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return STATUS[this.code];
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}
