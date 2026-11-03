// Every error leaves the API in one shape (RFC 9457 "problem details"):
//
//   { "type": ".../docs/errors#not_found", "title": "Not found", "status": 404,
//     "code": "not_found", "detail": "No job with that id.", "request_id": "req_…",
//     "errors": [{ "path": "email", "message": "Invalid email address" }] }

export type ErrorCode =
  | 'validation_failed'
  | 'invalid_json'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_transition'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'service_unavailable'
  | 'internal_error';

const TITLES: Record<ErrorCode, string> = {
  validation_failed: 'Validation failed',
  invalid_json: 'Invalid JSON',
  unauthorized: 'Unauthorized',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  invalid_transition: 'Invalid stage change',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  rate_limited: 'Too many requests',
  service_unavailable: 'Service unavailable',
  internal_error: 'Internal server error',
};

export const STATUS: Record<ErrorCode, number> = {
  validation_failed: 422,
  invalid_json: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  service_unavailable: 503,
  internal_error: 500,
};

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { errors?: FieldError[]; [key: string]: unknown } = {},
  ) {
    super(message);
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function problem(err: ApiError, requestId: string, baseUrl: string) {
  return {
    type: `${baseUrl}/docs#errors-${err.code}`,
    title: TITLES[err.code],
    status: err.status,
    code: err.code,
    detail: err.message,
    request_id: requestId,
    ...err.extra,
  };
}

export const notFound = (what: string) => new ApiError('not_found', `No ${what} with that id.`);

/** Translates the Postgres errors we expect into API errors. */
export function fromPostgres(err: unknown): ApiError | undefined {
  const e = err as { code?: string };
  if (!e || typeof e.code !== 'string') return undefined;
  switch (e.code) {
    case '23505':
      return new ApiError('conflict', 'A record with these details already exists.');
    case '23503':
      return new ApiError('validation_failed', 'A referenced record does not exist.');
    case '23514':
      return new ApiError('validation_failed', 'A value is outside the allowed range.');
    case '22001':
      return new ApiError('validation_failed', 'A value is too long.');
    default:
      return undefined;
  }
}
