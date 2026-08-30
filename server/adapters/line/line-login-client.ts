const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const LINE_ISSUER = 'https://access.line.me' as const;

export const LineLoginVerificationError = {
  INVALID_TOKEN: 'LINE_TOKEN_INVALID',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export class LineLoginError extends Error {
  constructor(readonly code: (typeof LineLoginVerificationError)[keyof typeof LineLoginVerificationError]) {
    super(code === LineLoginVerificationError.INVALID_TOKEN
      ? 'LINE identity token is invalid'
      : 'LINE verification is unavailable');
  }
}

export interface VerifiedLineIdentity {
  subject: string;
  audience: string;
  issuer: typeof LINE_ISSUER;
  expiresAt: string;
}

export interface LineVerificationResponse {
  readonly status: number;
  readonly redirected: boolean;
  json(): Promise<unknown>;
}

export type LineVerificationTransport = (request: Request) => Promise<LineVerificationResponse>;

export interface LineLoginClient {
  verifyIdToken(idToken: string): Promise<VerifiedLineIdentity>;
}

export interface LineLoginClientOptions {
  channelId: string;
  transport?: LineVerificationTransport;
  clock?: () => Date;
  timeoutMilliseconds?: number;
}

interface LineVerifyBody {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
}

function defaultTransport(request: Request): Promise<LineVerificationResponse> {
  return fetch(request, { redirect: 'error' });
}

function invalidToken(): LineLoginError {
  return new LineLoginError(LineLoginVerificationError.INVALID_TOKEN);
}

function unavailable(): LineLoginError {
  return new LineLoginError(LineLoginVerificationError.DEPENDENCY_UNAVAILABLE);
}

function validateBody(
  value: unknown,
  channelId: string,
  now: Date,
): VerifiedLineIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidToken();
  }
  const body = value as LineVerifyBody;
  if (
    body.iss !== LINE_ISSUER ||
    body.aud !== channelId ||
    typeof body.exp !== 'number' ||
    !Number.isFinite(body.exp) ||
    body.exp * 1000 <= now.getTime() ||
    typeof body.sub !== 'string' ||
    body.sub.trim().length === 0
  ) {
    throw invalidToken();
  }
  return {
    // Whitespace decides validity only; the verified provider subject itself is the
    // opaque identity key and must not be normalized before HMAC/encryption.
    subject: body.sub,
    audience: channelId,
    issuer: LINE_ISSUER,
    expiresAt: new Date(body.exp * 1000).toISOString(),
  };
}

export function createLineLoginClient(options: LineLoginClientOptions): LineLoginClient {
  if (!options.channelId || !options.channelId.trim()) {
    throw new Error('LINE Login channel ID is required');
  }
  const transport = options.transport ?? defaultTransport;
  const clock = options.clock ?? (() => new Date());
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 30_000) {
    throw new Error('LINE verification timeout is invalid');
  }

  return {
    async verifyIdToken(idToken: string): Promise<VerifiedLineIdentity> {
      if (!idToken || typeof idToken !== 'string') {
        throw invalidToken();
      }
      const controller = new AbortController();
      // `fetch` observes AbortSignal, but test transports and future adapters are
      // still required to have a bounded wait even if they accidentally ignore it.
      // Race the signal with a rejecting timer instead of relying on the transport
      // to cooperatively reject when it is aborted.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(unavailable());
        }, timeoutMilliseconds);
      });
      const request = new Request(LINE_VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: options.channelId }).toString(),
        redirect: 'error',
        signal: controller.signal,
      });
      let response: LineVerificationResponse;
      try {
        response = await Promise.race([transport(request), timeoutFailure]);
      } catch (error) {
        if (error instanceof LineLoginError) {
          throw error;
        }
        throw unavailable();
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
      if (response.redirected || response.status >= 500) {
        throw unavailable();
      }
      if (response.status < 200 || response.status >= 300) {
        throw invalidToken();
      }
      try {
        return validateBody(await response.json(), options.channelId, clock());
      } catch (error) {
        if (error instanceof LineLoginError) {
          throw error;
        }
        throw invalidToken();
      }
    },
  };
}

export { LINE_VERIFY_URL };
