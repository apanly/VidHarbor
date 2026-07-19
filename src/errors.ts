export const ERROR_HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  PROXY_NOT_FOUND: 404,
  CHANNEL_NOT_FOUND: 404,
  VIDEO_NOT_FOUND: 404,
  NOTIFICATION_NOT_FOUND: 404,
  DOWNLOAD_NOT_FOUND: 404,
  DOWNLOAD_FILE_UNAVAILABLE: 404,
  DOWNLOAD_RANGE_NOT_SATISFIABLE: 416,
  PROXY_NAME_EXISTS: 409,
  PROXY_IN_USE: 409,
  CHANNEL_ALREADY_EXISTS: 409,
  CHANNEL_NAME_EXISTS: 409,
  CHANNEL_IN_USE: 409,
  DOWNLOAD_ALREADY_EXISTS: 409,
  DOWNLOAD_ROOT_OUTSIDE_MOUNT: 422,
  DOWNLOAD_ROOT_UNAVAILABLE: 422,
  DOWNLOAD_ROOT_NOT_CONFIGURED: 422,
  UNSUPPORTED_PLATFORM: 422,
  NOT_A_CHANNEL_URL: 422,
  NOT_A_VIDEO_URL: 422,
  GLOBAL_INTERVAL_NOT_CONFIGURED: 422,
  CHANNEL_FETCH_FAILED: 422,
  CHANNEL_METADATA_INVALID: 422,
  VIDEO_FETCH_FAILED: 422,
  VIDEO_METADATA_INVALID: 422,
  PERSISTENCE_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;
export type ErrorHttpStatus = (typeof ERROR_HTTP_STATUS)[ErrorCode];

export interface ErrorResponse {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
  };
}

export class BusinessError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    getHttpStatus(code);
    this.name = 'BusinessError';
    this.code = code;
  }
}

export function getHttpStatus(code: ErrorCode): ErrorHttpStatus {
  if (!Object.hasOwn(ERROR_HTTP_STATUS, code)) {
    throw new TypeError(`unknown error code: ${String(code)}`);
  }

  return ERROR_HTTP_STATUS[code];
}

export function toErrorResponse(error: BusinessError): ErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}
