import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { FlowPassDatabase } from '../db/connection';
import type { FieldCrypto } from '../crypto/field-crypto';
import { hashToken } from '../crypto/token-hash';
import { listAiRunsForAdmin } from '../db/repositories/ai-runs';
import { decryptDatabaseText } from '../db/repositories/encrypted-fields';
import { getDocumentForAdmin, listDocumentsForAdmin, type AdminDocumentRecord } from '../db/repositories/documents';
import type { DocumentVault } from '../services/document-vault';
import { localReadiness } from '../services/health-service';
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, verifyAdminCsrf } from './auth/admin-session';
import { ADMIN_RECOVERY_EMAIL, changeAdminPassword, createAdminRecoveryChallenge, loginAdmin, resetAdminPasswordWithChallenge } from './auth/admin-account';
import { createReviewRoutes } from './routes/reviews';
import { createProgramRoutes } from './routes/programs';
import { createIncidentRoutes } from './routes/incidents';
import { createToolRoutes } from './routes/tools';
import { createDataManagementRoutes } from './routes/data-management';
import { DEFAULT_GEMINI_QUOTA_MODELS } from '../adapters/gemini/model-quota-router';

export interface CloudflareAccessIdentity {
  email: string;
  issuedAt: number;
}

export interface AdminAppDependencies {
  crypto?: FieldCrypto;
  documentVault?: DocumentVault;
  documentVaultPath?: string;
  dataRoot?: string;
  backupRoot?: string;
  verifyAccessToken?: (token: string) => Promise<CloudflareAccessIdentity | null>;
}

const LOCAL_HOST = '127.0.0.1:38101';
const LOCAL_ORIGIN = 'http://127.0.0.1:38101';
const REMOTE_HOST = 'admin.luecat.com';
const REMOTE_ORIGIN = 'https://admin.luecat.com';
const INLINE_DOCUMENT_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

function cookie(request: Context['req'], name: string): string | null {
  const match = request.header('cookie')?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match?.[1]) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function setSessionCookies(response: Response, session: { token: string; csrf: string }, secure: boolean): void {
  const security = secure ? '; Secure' : '';
  response.headers.append('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${security}`);
  response.headers.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=${encodeURIComponent(session.csrf)}; SameSite=Strict; Path=/; Max-Age=28800${security}`);
}

function clearSessionCookies(response: Response, secure: boolean): void {
  const security = secure ? '; Secure' : '';
  response.headers.append('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${security}`);
  response.headers.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=; SameSite=Strict; Path=/; Max-Age=0${security}`);
}

async function requestBoundary(context: Context, dependencies: AdminAppDependencies, mutation: boolean): Promise<{ remote: boolean; email?: string; issuedAt?: number } | null> {
  const host = (context.req.header('host') ?? '').toLowerCase();
  const origin = context.req.header('origin');
  if (host === LOCAL_HOST) return mutation && origin !== LOCAL_ORIGIN ? null : { remote: false };
  if (host !== REMOTE_HOST || (mutation && origin !== REMOTE_ORIGIN) || !dependencies.verifyAccessToken) return null;
  const assertion = context.req.header('cf-access-jwt-assertion');
  if (!assertion) return null;
  const identity = await dependencies.verifyAccessToken(assertion).catch(() => null);
  if (!identity || identity.email.trim().toLowerCase() !== ADMIN_RECOVERY_EMAIL) return null;
  return { remote: true, email: identity.email.trim().toLowerCase(), issuedAt: identity.issuedAt };
}

function recentRemoteAccess(boundary: { remote: boolean; email?: string; issuedAt?: number } | null, now = Date.now()): boundary is { remote: true; email: string; issuedAt: number } {
  if (!boundary?.remote || !boundary.email || typeof boundary.issuedAt !== 'number') return false;
  const ageSeconds = Math.floor(now / 1000) - boundary.issuedAt;
  return ageSeconds >= -30 && ageSeconds <= 10 * 60;
}

function authenticated(database: FlowPassDatabase, context: Context) {
  return authenticateAdmin(database, cookie(context.req, ADMIN_SESSION_COOKIE));
}

function csrfAuthenticated(database: FlowPassDatabase, context: Context) {
  const auth = authenticated(database, context);
  if (!auth || !verifyAdminCsrf(context.req.header('x-csrf-token') ?? null, auth.csrfHash)) return null;
  return auth;
}

function accountState(database: FlowPassDatabase, adminId: string) {
  return database.prepare(`SELECT display_name, must_change_password, password_expires_at FROM admin_users WHERE id = ? AND status = 'active'`).get(adminId) as { display_name: string; must_change_password: number; password_expires_at: string | null } | undefined;
}

function originalDocumentName(document: AdminDocumentRecord, crypto?: FieldCrypto): string {
  if (!crypto) return '附件';
  try {
    return decryptDatabaseText(crypto, 'documents', 'original_name_enc', document.id, document.originalNameEnc);
  } catch {
    return '附件';
  }
}

function encodedFilename(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function createAdminApp(database?: FlowPassDatabase, dependencies: AdminAppDependencies = {}) {
  const app = new Hono();

  app.use('*', async (context, next) => {
    await next();
    context.header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Cache-Control', 'no-store');
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });

  app.get('/healthz', (context) => context.json({ status: 'ok', dependencies: { database: database ? 'available' : 'pending', keychain: dependencies.crypto ? 'available' : 'pending' } }));
  app.get('/readyz', (context) => {
    if (!database) return context.json({ ready: false, database: 'unavailable', vault: 'unavailable', migrations: 'unavailable', keychain: dependencies.crypto ? 'ready' : 'unavailable' }, 503);
    const result = localReadiness(database, dependencies.documentVaultPath);
    const keychain = dependencies.crypto && dependencies.documentVault ? 'ready' : 'unavailable';
    const ready = result.ready && result.vault === 'ready' && keychain === 'ready';
    return context.json({ ...result, ready, keychain }, ready ? 200 : 503);
  });

  const accountRoutes = new Set([
    'POST /admin/v1/sessions',
    'GET /admin/v1/session',
    'DELETE /admin/v1/sessions/current',
    'POST /admin/v1/password/change',
    'POST /admin/v1/password-recovery/start',
    'POST /admin/v1/password-recovery/complete',
  ]);
  app.use('/admin/v1/*', async (context, next) => {
    if (!database || accountRoutes.has(`${context.req.method} ${context.req.path}`)) return next();
    const mutation = context.req.method !== 'GET' && context.req.method !== 'HEAD';
    if (!await requestBoundary(context, dependencies, mutation)) return context.json({ error: { code: 'ACCESS_REQUIRED', message: '無法驗證此來源。' } }, 403);
    const auth = authenticated(database, context);
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED', message: '請重新登入。' } }, 401);
    const account = accountState(database, auth.adminId);
    if (!account) return context.json({ error: { code: 'UNAUTHENTICATED', message: '請重新登入。' } }, 401);
    if (account.must_change_password === 1) return context.json({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '請先變更初始密碼。' } }, 403);
    return next();
  });

  app.post('/admin/v1/sessions', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '服務暫時無法使用。' } }, 503);
    const boundary = await requestBoundary(context, dependencies, true);
    if (!boundary) return context.json({ error: { code: 'CSRF_FAILED', message: '無法驗證此登入來源。' } }, 403);
    const body = await context.req.json().catch(() => null) as { password?: string } | null;
    if (typeof body?.password !== 'string') return context.json({ error: { code: 'INVALID_REQUEST', message: '請輸入密碼。' } }, 400);
    const login = await loginAdmin(database, 'admin', body.password);
    if (!login.ok) return context.json({ error: { code: 'UNAUTHENTICATED', message: '帳號或密碼錯誤。' } }, 401);
    const session = createAdminSession(database, login.adminId);
    const response = context.json({ data: { expiresAt: session.expiresAt, mustChangePassword: login.mustChangePassword } }, 201);
    setSessionCookies(response, session, boundary.remote);
    return response;
  });

  app.get('/admin/v1/session', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '服務暫時無法使用。' } }, 503);
    if (!await requestBoundary(context, dependencies, false)) return context.json({ error: { code: 'UNAVAILABLE', message: '無法驗證此來源。' } }, 403);
    const auth = authenticated(database, context);
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED', message: '請重新登入。' } }, 401);
    const account = accountState(database, auth.adminId);
    if (!account) return context.json({ error: { code: 'UNAUTHENTICATED', message: '請重新登入。' } }, 401);
    return context.json({ data: { authenticated: true, displayName: account.display_name, mustChangePassword: account.must_change_password === 1, passwordExpiresAt: account.password_expires_at } });
  });

  app.delete('/admin/v1/sessions/current', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '服務暫時無法使用。' } }, 503);
    const boundary = await requestBoundary(context, dependencies, true);
    const auth = csrfAuthenticated(database, context);
    if (!boundary || !auth) return context.json({ error: { code: 'CSRF_FAILED', message: '請重新登入。' } }, 403);
    const sessionToken = cookie(context.req, ADMIN_SESSION_COOKIE);
    if (sessionToken) database.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(new Date().toISOString(), hashToken(sessionToken));
    const response = context.json({ data: { loggedOut: true } });
    clearSessionCookies(response, boundary.remote);
    return response;
  });

  app.post('/admin/v1/password/change', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '服務暫時無法使用。' } }, 503);
    const boundary = await requestBoundary(context, dependencies, true);
    const auth = csrfAuthenticated(database, context);
    if (!boundary || !auth) return context.json({ error: { code: 'CSRF_FAILED', message: '請重新登入。' } }, 403);
    const body = await context.req.json().catch(() => null) as { currentPassword?: string; newPassword?: string } | null;
    if (typeof body?.currentPassword !== 'string' || typeof body.newPassword !== 'string') return context.json({ error: { code: 'INVALID_REQUEST', message: '密碼欄位不完整。' } }, 400);
    const changed = await changeAdminPassword(database, auth.adminId, body.currentPassword, body.newPassword);
    if (!changed.ok) return context.json({ error: { code: 'PASSWORD_REJECTED', message: '目前密碼或新密碼不符合要求。', details: changed.errors } }, 400);
    const session = createAdminSession(database, auth.adminId);
    const response = context.json({ data: { changed: true } });
    setSessionCookies(response, session, boundary.remote);
    return response;
  });

  app.post('/admin/v1/password-recovery/start', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '若身分符合，系統會允許繼續。' } }, 503);
    const boundary = await requestBoundary(context, dependencies, true);
    if (!recentRemoteAccess(boundary)) return context.json({ error: { code: 'ACCESS_REQUIRED', message: '請先由遠端入口重新完成 Email OTP。' } }, 403);
    const challenge = createAdminRecoveryChallenge(database, boundary.email);
    if (!challenge) return context.json({ error: { code: 'RECOVERY_UNAVAILABLE', message: '若身分符合，系統會允許繼續。' } }, 400);
    return context.json({ data: { challengeToken: challenge.token, expiresAt: challenge.expiresAt } }, 201);
  });

  app.post('/admin/v1/password-recovery/complete', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '無法完成密碼重設。' } }, 503);
    const boundary = await requestBoundary(context, dependencies, true);
    if (!recentRemoteAccess(boundary)) return context.json({ error: { code: 'ACCESS_REQUIRED', message: '請先由遠端入口重新完成 Email OTP。' } }, 403);
    const body = await context.req.json().catch(() => null) as { challengeToken?: string; newPassword?: string } | null;
    if (typeof body?.challengeToken !== 'string' || typeof body.newPassword !== 'string') return context.json({ error: { code: 'INVALID_REQUEST', message: '無法完成密碼重設。' } }, 400);
    const reset = await resetAdminPasswordWithChallenge(database, body.challengeToken, body.newPassword);
    if (!reset.ok) return context.json({ error: { code: 'RECOVERY_FAILED', message: '無法完成密碼重設。', details: reset.errors } }, 400);
    return context.json({ data: { reset: true } });
  });

  app.get('/admin/v1/cases', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '服務暫時無法使用。' } }, 503);
    if (!await requestBoundary(context, dependencies, false)) return context.json({ error: { code: 'UNAVAILABLE', message: '無法驗證此來源。' } }, 403);
    const auth = authenticated(database, context);
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED', message: '請重新登入。' } }, 401);
    const account = accountState(database, auth.adminId);
    if (!account || account.must_change_password === 1) return context.json({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '請先變更初始密碼。' } }, 403);
    const rows = database.prepare(`SELECT id, case_code, state, requested_amount_twd, calculated_amount_twd, approved_amount_twd, disbursed_amount_twd, submitted_at, updated_at, row_version FROM cases WHERE deleted_at IS NULL ORDER BY updated_at DESC`).all();
    return context.json({ data: { cases: rows } });
  });

  app.get('/admin/v1/ai-usage', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '服務暫時無法使用。' } }, 503);
    if (!await requestBoundary(context, dependencies, false)) return context.json({ error: { code: 'UNAVAILABLE', message: '無法驗證此來源。' } }, 403);
    if (!authenticated(database, context)) return context.json({ error: { code: 'UNAUTHENTICATED', message: '請重新登入。' } }, 401);
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const models = DEFAULT_GEMINI_QUOTA_MODELS.map((model) => {
      const minute = database.prepare('SELECT request_count, input_tokens FROM ai_model_quota_usage WHERE model_id = ? AND minute_key = ? AND day_key = ?').get(model.id, minuteKey, dayKey) as { request_count: number; input_tokens: number } | undefined;
      const daily = database.prepare('SELECT COALESCE(SUM(request_count), 0) AS request_count FROM ai_model_quota_usage WHERE model_id = ? AND day_key = ?').get(model.id, dayKey) as { request_count: number };
      const runs = database.prepare('SELECT COUNT(*) AS count FROM ai_runs WHERE model_id = ?').get(model.id) as { count: number };
      return {
        id: model.id,
        rpm: { used: minute?.request_count ?? 0, limit: model.rpm, remaining: Math.max(0, model.rpm - (minute?.request_count ?? 0)) },
        tpm: { used: minute?.input_tokens ?? 0, limit: model.tpm, remaining: Math.max(0, model.tpm - (minute?.input_tokens ?? 0)) },
        rpd: { used: daily.request_count, limit: model.rpd, remaining: Math.max(0, model.rpd - daily.request_count) },
        recordedRuns: runs.count,
      };
    });
    return context.json({ data: { provider: 'gemini', minuteKey, dayKey, models } });
  });

  app.get('/admin/v1/cases/:caseId/documents', (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE', message: '服務暫時無法使用。' } }, 503);
    const auth = authenticated(database, context);
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED', message: '請重新登入。' } }, 401);
    const caseId = context.req.param('caseId');
    const existingCase = database.prepare('SELECT id FROM cases WHERE id = ? AND deleted_at IS NULL').get(caseId);
    if (!existingCase) return context.json({ error: { code: 'NOT_FOUND', message: '找不到這筆案件。' } }, 404);
    const documents = listDocumentsForAdmin(database, { adminId: auth.adminId }, caseId).map((document) => ({
      id: document.id,
      kind: document.kind,
      requirementKey: document.requirementKey,
      mediaType: document.mediaType,
      byteSize: document.byteSize,
      originalName: originalDocumentName(document, dependencies.crypto),
      status: document.status,
      createdAt: document.createdAt,
      rowVersion: document.rowVersion,
    }));
    return context.json({ data: { documents } });
  });

  app.get('/admin/v1/documents/:documentId/content', (context) => {
    if (!database || !dependencies.documentVault) return context.json({ error: { code: 'UNAVAILABLE', message: '附件服務暫時無法使用。' } }, 503);
    const auth = authenticated(database, context);
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED', message: '請重新登入。' } }, 401);
    const document = getDocumentForAdmin(database, { adminId: auth.adminId }, context.req.param('documentId'));
    if (!document || document.status !== 'ready' || document.deletedAt || !INLINE_DOCUMENT_MEDIA_TYPES.has(document.mediaType)) return context.json({ error: { code: 'NOT_FOUND', message: '找不到這份附件。' } }, 404);
    try {
      const bytes = dependencies.documentVault.read({ id: document.id, storageId: document.storageId, keyId: document.keyId });
      const originalName = originalDocumentName(document, dependencies.crypto);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': document.mediaType,
          'Content-Disposition': `inline; filename="flowpass-document"; filename*=UTF-8''${encodedFilename(originalName)}`,
          'Content-Length': String(bytes.byteLength),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
      });
    } catch {
      return context.json({ error: { code: 'UNAVAILABLE', message: '附件目前無法開啟。' } }, 503);
    }
  });

  app.get('/admin/v1/cases/:caseId/audit', async (context) => {
    if (!database) return context.json({ error: { code: 'UNAVAILABLE' } }, 503);
    if (!await requestBoundary(context, dependencies, false)) return context.json({ error: { code: 'UNAVAILABLE' } }, 403);
    const auth = authenticated(database, context);
    if (!auth) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401);
    const account = accountState(database, auth.adminId);
    if (!account || account.must_change_password === 1) return context.json({ error: { code: 'PASSWORD_CHANGE_REQUIRED' } }, 403);
    const caseId = context.req.param('caseId');
    const existingCase = database.prepare('SELECT id FROM cases WHERE id = ? AND deleted_at IS NULL').get(caseId);
    if (!existingCase) return context.json({ error: { code: 'NOT_FOUND' } }, 404);
    return context.json({ data: { aiRuns: listAiRunsForAdmin(database, { adminId: auth.adminId }, caseId) } });
  });

  if (database && dependencies.crypto) app.route('/', createReviewRoutes(database, dependencies.crypto));
  if (database) app.route('/', createProgramRoutes(database));
  if (database && dependencies.crypto) app.route('/', createIncidentRoutes(database, dependencies.crypto));
  if (database) app.route('/', createToolRoutes(database, dependencies.crypto));
  if (database) app.route('/', createDataManagementRoutes(database, {
    crypto: dependencies.crypto,
    documentVault: dependencies.documentVault,
    dataRoot: dependencies.dataRoot,
    backupRoot: dependencies.backupRoot,
    authenticated: (context) => authenticated(database, context),
    csrfAuthenticated: (context) => csrfAuthenticated(database, context),
  }));

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceAdmin = join(moduleDirectory, '..', '..', 'dist', 'admin');
  const releaseAdmin = join(moduleDirectory, '..', 'admin');
  const adminRoot = existsSync(sourceAdmin) ? sourceAdmin : releaseAdmin;
  app.get('/', (context) => {
    const html = readFileSync(join(adminRoot, 'index.html'), 'utf8');
    const stylesheet = html.match(/href="([^"]+\.css)"/)?.[1];
    if (!stylesheet) return context.html(html);
    const cssPath = join(adminRoot, stylesheet.replace(/^\/assets\//, 'assets/'));
    const css = readFileSync(cssPath, 'utf8');
    const inline = `<style>${css}</style>`;
    return context.html(html.replace('</head>', `${inline}</head>`));
  });
  app.get('/assets/:asset', (context) => serveStatic({ root: adminRoot, path: `assets/${context.req.param('asset')}` })(context, async () => undefined));

  return app;
}
