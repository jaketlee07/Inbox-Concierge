export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly cause?: unknown;

  constructor(code: string, message: string, statusCode: number, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized', cause?: unknown) {
    super('AUTH_ERROR', message, 401, cause);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', cause?: unknown) {
    super('VALIDATION_ERROR', message, 400, cause);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded', cause?: unknown) {
    super('RATE_LIMIT', message, 429, cause);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', cause?: unknown) {
    super('NOT_FOUND', message, 404, cause);
  }
}

export class ExternalApiError extends AppError {
  constructor(service: string, message: string, cause?: unknown) {
    super('EXTERNAL_API_ERROR', `${service}: ${message}`, 502, cause);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export interface ErrorResponse {
  error: { code: string; message: string };
  statusCode: number;
}

export function toErrorResponse(e: unknown): ErrorResponse {
  if (isAppError(e)) {
    const message = e.statusCode >= 500 ? 'Internal server error' : e.message;
    return { error: { code: e.code, message }, statusCode: e.statusCode };
  }
  return {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    statusCode: 500,
  };
}
