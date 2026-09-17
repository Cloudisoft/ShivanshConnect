/**
 * Known application error types, mapped to friendly, human-readable
 * messages by the central error handler in index.ts. Never let a raw
 * exception (stack trace, DB error text, etc.) reach the client.
 */
export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'You must be signed in to do that.') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'This action conflicts with existing data.', details?: unknown) {
    super(409, 'CONFLICT', message, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request contains invalid data.', details?: unknown) {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Please slow down and try again shortly.') {
    super(429, 'RATE_LIMITED', message);
  }
}
