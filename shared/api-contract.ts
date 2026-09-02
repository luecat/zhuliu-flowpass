import { z } from 'zod';

export const ApiErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_STATE: 'INVALID_STATE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  CSRF_FAILED: 'CSRF_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  ETAG_MISMATCH: 'ETAG_MISMATCH',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  LINE_TOKEN_INVALID: 'LINE_TOKEN_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  MODEL_OFFLINE: 'MODEL_OFFLINE',
  MODEL_AUTH_FAILED: 'MODEL_AUTH_FAILED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_RATE_LIMITED: 'MODEL_RATE_LIMITED',
  AI_INPUT_TOO_LARGE: 'AI_INPUT_TOO_LARGE',
  AI_INPUT_UNSAFE: 'AI_INPUT_UNSAFE',
  AI_OUTPUT_INVALID: 'AI_OUTPUT_INVALID',
  AI_OUTPUT_UNSAFE: 'AI_OUTPUT_UNSAFE',
  PASSPORT_NOT_READY: 'PASSPORT_NOT_READY',
  DOCUMENT_NOT_READY: 'DOCUMENT_NOT_READY',
  UNSUPPORTED_FILE: 'UNSUPPORTED_FILE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_UNREADABLE: 'FILE_UNREADABLE',
  FILE_ENCRYPTED: 'FILE_ENCRYPTED',
  FILE_TOO_MANY_PAGES: 'FILE_TOO_MANY_PAGES',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

const ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  INVALID_REQUEST: 'Request is invalid',
  INVALID_STATE: 'The resource is not in a mutable state',
  UNAUTHENTICATED: 'Authentication is required',
  CSRF_FAILED: 'Request could not be verified',
  NOT_FOUND: 'Resource not found',
  ETAG_MISMATCH: 'Resource version does not match',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key was reused',
  LINE_TOKEN_INVALID: 'LINE identity token is invalid',
  RATE_LIMITED: 'Too many requests',
  DEPENDENCY_UNAVAILABLE: 'Service dependency is unavailable',
  MODEL_OFFLINE: 'The local model is unavailable',
  MODEL_AUTH_FAILED: 'The local model could not authenticate',
  MODEL_NOT_FOUND: 'The configured model was not found',
  MODEL_TIMEOUT: 'The local model timed out',
  MODEL_RATE_LIMITED: 'The local model is busy',
  AI_INPUT_TOO_LARGE: 'The answers are too large for the model',
  AI_INPUT_UNSAFE: 'The answers contain instructions that cannot be processed',
  AI_OUTPUT_INVALID: 'The model returned an invalid passport',
  AI_OUTPUT_UNSAFE: 'The model returned an unsafe passport',
  PASSPORT_NOT_READY: 'The passport is not ready for submission',
  DOCUMENT_NOT_READY: 'Required documents are not ready',
  UNSUPPORTED_FILE: 'The uploaded file type is not supported',
  FILE_TOO_LARGE: 'The uploaded file is too large',
  FILE_UNREADABLE: 'The uploaded file could not be read',
  FILE_ENCRYPTED: 'The uploaded file is encrypted',
  FILE_TOO_MANY_PAGES: 'The uploaded file has too many pages',
  IMAGE_TOO_LARGE: 'The uploaded image is too large',
};

const ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  INVALID_REQUEST: 400,
  INVALID_STATE: 409,
  UNAUTHENTICATED: 401,
  LINE_TOKEN_INVALID: 401,
  CSRF_FAILED: 403,
  NOT_FOUND: 404,
  ETAG_MISMATCH: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  MODEL_OFFLINE: 503,
  MODEL_AUTH_FAILED: 503,
  MODEL_NOT_FOUND: 503,
  MODEL_TIMEOUT: 503,
  MODEL_RATE_LIMITED: 503,
  AI_INPUT_TOO_LARGE: 400,
  AI_INPUT_UNSAFE: 422,
  AI_OUTPUT_INVALID: 503,
  AI_OUTPUT_UNSAFE: 503,
  PASSPORT_NOT_READY: 422,
  DOCUMENT_NOT_READY: 422,
  UNSUPPORTED_FILE: 415,
  FILE_TOO_LARGE: 413,
  FILE_UNREADABLE: 422,
  FILE_ENCRYPTED: 415,
  FILE_TOO_MANY_PAGES: 422,
  IMAGE_TOO_LARGE: 413,
};

export interface ApiSuccess<T> {
  data: T;
  meta: {
    requestId: string;
    etag?: string;
  };
}

export interface ApiFailure {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
  };
  /** Internal response metadata. These fields are non-enumerable and never serialize into the JSON body. */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export function apiSuccess<T>(data: T, requestId: string, rowVersion?: string | number): ApiSuccess<T> {
  const etag = rowVersion === undefined ? undefined : quotedEtag(rowVersion);
  return {
    data,
    meta: etag ? { requestId, etag } : { requestId },
  };
}

export function apiFailure(
  code: ApiErrorCode,
  requestId: string,
  options: { retryAfter?: number } = {},
): ApiFailure {
  const response = {
    error: {
      code,
      message: ERROR_MESSAGES[code],
      requestId,
    },
  } as ApiFailure;
  const retryAfter = options.retryAfter;
  const headers: Record<string, string> = {};
  if (code === ApiErrorCode.RATE_LIMITED && Number.isInteger(retryAfter) && retryAfter! >= 0) {
    headers['Retry-After'] = String(retryAfter);
  }
  Object.defineProperties(response, {
    status: { value: ERROR_STATUS[code], enumerable: false },
    headers: { value: Object.freeze(headers), enumerable: false },
  });
  return response;
}

export function toJsonResponse(body: ApiSuccess<unknown> | ApiFailure, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if ('error' in body) {
    for (const [name, value] of Object.entries(body.headers)) {
      headers.set(name, value);
    }
    return Response.json(body, { ...init, status: body.status, headers });
  }
  return Response.json(body, { ...init, status: init?.status ?? 200, headers });
}

const QUOTED_ETAG = /^"(0|[1-9][0-9]*)"$/;

export function quotedEtag(value: string | number): string {
  const normalized = typeof value === 'number' ? String(value) : value;
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error('ETag row version is invalid');
  }
  return `"${normalized}"`;
}

export function parseQuotedEtag(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = QUOTED_ETAG.exec(value);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export const LineExchangeRequestSchema = z
  .object({
    idToken: z.string().min(1).max(16_384),
    nonce: z.string().min(1).max(256),
  })
  .strict();

export type LineExchangeRequest = z.infer<typeof LineExchangeRequestSchema>;
