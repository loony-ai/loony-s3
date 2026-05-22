export type ErrorCode =
  | 'BUCKET_NOT_FOUND'
  | 'BUCKET_ALREADY_EXISTS'
  | 'BUCKET_NOT_EMPTY'
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_EXPIRED'
  | 'UPLOAD_NOT_FOUND'
  | 'INVALID_BUCKET_NAME'
  | 'INVALID_OBJECT_KEY'
  | 'INVALID_PART_NUMBER'
  | 'INVALID_PART_SIZE'
  | 'INVALID_CONTENT_LENGTH'
  | 'ACCESS_DENIED'
  | 'UNAUTHORIZED'
  | 'PRESIGNED_URL_EXPIRED'
  | 'PRESIGNED_URL_INVALID'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED';

const HTTP_STATUS: Record<ErrorCode, number> = {
  BUCKET_NOT_FOUND: 404,
  BUCKET_ALREADY_EXISTS: 409,
  BUCKET_NOT_EMPTY: 409,
  OBJECT_NOT_FOUND: 404,
  OBJECT_EXPIRED: 410,
  UPLOAD_NOT_FOUND: 404,
  INVALID_BUCKET_NAME: 400,
  INVALID_OBJECT_KEY: 400,
  INVALID_PART_NUMBER: 400,
  INVALID_PART_SIZE: 400,
  INVALID_CONTENT_LENGTH: 400,
  ACCESS_DENIED: 403,
  UNAUTHORIZED: 401,
  PRESIGNED_URL_EXPIRED: 403,
  PRESIGNED_URL_INVALID: 403,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
};

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly isOperational: boolean;

  constructor(code: ErrorCode, message: string, isOperational = true) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = HTTP_STATUS[code];
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
      },
    };
  }
}
