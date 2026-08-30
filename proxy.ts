import { NextResponse, type NextRequest } from 'next/server';

/**
 * Headers-only boundary: all authoritative access control remains in route
 * services and repositories, never in proxy navigation behavior.
 */
export function proxy(request: NextRequest): NextResponse {
  void request;
  const response = NextResponse.next();
  // Do not guess CSP script/frame origins before the project owner configures
  // the actual LIFF application. An accidental allowlist could break the LIFF
  // container; the final CSP is an external-account integration gate.
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=()');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return response;
}
