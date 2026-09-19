const CSRF_COOKIE = 'flowpass_admin_csrf';

export type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
export type AdminRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code?: string, message?: string) {
    super(message ?? '服務暫時無法完成此操作，請稍後再試。');
  }
}

function cookie(name: string) {
  const found = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  try {
    return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
  } catch {
    return null;
  }
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = cookie(CSRF_COOKIE);
    if (token) headers.set('x-csrf-token', token);
  }
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '無法連線至管理服務，請確認本機後台已啟動。');
  }
  const payload = await response.json().catch(() => ({})) as Envelope<T> & T;
  if (!response.ok) throw new ApiError(response.status, payload.error?.code, payload.error?.message);
  return (payload.data ?? payload) as T;
}
