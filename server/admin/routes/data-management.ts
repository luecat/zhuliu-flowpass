import { Hono, type Context } from 'hono';
import type { FieldCrypto } from '../../crypto/field-crypto';
import type { FlowPassDatabase } from '../../db/connection';
import type { DocumentVault } from '../../services/document-vault';
import { getAdminPassportDataSnapshot } from '../../services/admin-passport-data-service';
import { AdminPassportEditError, editAdminPassportField } from '../../services/admin-passport-edit-service';
import { AdminPassportPurgeError, authorizePassportPurge, executePassportPurge, previewPassportPurge } from '../../services/admin-passport-purge-service';
import { getMaintenanceState } from '../../services/maintenance-mode';
import type { AdminFieldPatch, PurgeAuthorizationRequest } from '../../../shared/admin-data-management-contract';

interface AdminIdentity { adminId: string }
export interface DataManagementRouteDependencies {
  crypto?: FieldCrypto;
  documentVault?: DocumentVault;
  dataRoot?: string;
  backupRoot?: string;
  authenticated: (context: Context) => AdminIdentity | null;
  csrfAuthenticated: (context: Context) => AdminIdentity | null;
}

function jsonError(context: Context, code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503) {
  return context.json({ error: { code, message } }, status);
}

function bodyAllowed(context: Context): boolean {
  const length = Number(context.req.header('content-length') ?? '0');
  return Number.isFinite(length) && length <= 64 * 1024;
}

function resolveCaseId(database: FlowPassDatabase, value: string): string | null {
  const row = database.prepare('SELECT id FROM cases WHERE (id = ? OR case_code = ?) AND deleted_at IS NULL').get(value, value) as { id: string } | undefined;
  return row?.id ?? null;
}

function editError(context: Context, error: unknown) {
  if (error instanceof AdminPassportEditError) {
    if (error.code === 'NOT_FOUND') return jsonError(context, error.code, '找不到這筆資料。', 404);
    if (error.code === 'ROW_CONFLICT') return jsonError(context, error.code, '資料已被更新，請重新載入。', 409);
    if (error.code === 'LOCKED_FIELD') return jsonError(context, error.code, '此欄位由系統管理，無法修改。', 400);
    return jsonError(context, error.code, '欄位內容不符合格式。', 400);
  }
  return jsonError(context, 'UPDATE_FAILED', '資料目前無法更新。', 500);
}

function purgeError(context: Context, error: unknown) {
  if (error instanceof AdminPassportPurgeError) {
    if (error.code === 'NOT_FOUND') return jsonError(context, error.code, '找不到這筆案件。', 404);
    if (error.code === 'PASSWORD_REJECTED') return jsonError(context, error.code, '管理員密碼錯誤。', 403);
    if (error.code === 'AUTHORIZATION_REJECTED') return jsonError(context, error.code, '刪除授權已失效，請重新確認。', 403);
    if (error.code === 'PREVIEW_EXPIRED') return jsonError(context, error.code, '資料已變更，請重新檢視刪除範圍。', 409);
    if (error.code === 'MAINTENANCE_CONFLICT' || error.code === 'ACTIVE_JOBS') return jsonError(context, error.code, '系統仍有工作進行中，請稍後再試。', 409);
  }
  return jsonError(context, 'PURGE_FAILED', '清除未完成，系統已保持安全狀態。', 500);
}

export function createDataManagementRoutes(database: FlowPassDatabase, dependencies: DataManagementRouteDependencies) {
  const app = new Hono();

  app.get('/admin/v1/data/maintenance-status', (context) => {
    if (!dependencies.authenticated(context)) return jsonError(context, 'UNAUTHENTICATED', '請重新登入。', 401);
    const state = getMaintenanceState(database);
    return context.json({ data: { active: state.active, phase: state.phase, updatedAt: state.updatedAt } });
  });

  app.get('/admin/v1/data/passports/:caseId', (context) => {
    if (!dependencies.authenticated(context)) return jsonError(context, 'UNAUTHENTICATED', '請重新登入。', 401);
    if (!dependencies.crypto) return jsonError(context, 'UNAVAILABLE', '資料解密服務目前無法使用。', 503);
    const caseId = resolveCaseId(database, context.req.param('caseId'));
    const snapshot = caseId ? getAdminPassportDataSnapshot(database, dependencies.crypto, caseId) : null;
    return snapshot ? context.json({ data: snapshot }) : jsonError(context, 'NOT_FOUND', '找不到這筆案件。', 404);
  });

  app.patch('/admin/v1/data/passports/:caseId/fields', async (context) => {
    const auth = dependencies.csrfAuthenticated(context);
    if (!auth) return jsonError(context, 'CSRF_FAILED', '請重新登入。', 403);
    if (!dependencies.crypto) return jsonError(context, 'UNAVAILABLE', '資料解密服務目前無法使用。', 503);
    if (!bodyAllowed(context)) return jsonError(context, 'PAYLOAD_TOO_LARGE', '請求內容過大。', 413);
    const body = await context.req.json().catch(() => null) as AdminFieldPatch | null;
    if (!body || typeof body.resource !== 'string' || typeof body.recordId !== 'string' || typeof body.field !== 'string' || !Number.isInteger(body.expectedRowVersion)) return jsonError(context, 'INVALID_REQUEST', '修改內容不完整。', 400);
    const caseId = resolveCaseId(database, context.req.param('caseId'));
    if (!caseId) return jsonError(context, 'NOT_FOUND', '找不到這筆案件。', 404);
    try {
      const result = editAdminPassportField({ ...body, database, crypto: dependencies.crypto, caseId, adminId: auth.adminId, requestId: crypto.randomUUID() });
      return context.json({ data: result });
    } catch (error) { return editError(context, error); }
  });

  app.post('/admin/v1/data/passports/:caseId/purge-preview', (context) => {
    if (!dependencies.csrfAuthenticated(context)) return jsonError(context, 'CSRF_FAILED', '請重新登入。', 403);
    if (!dependencies.crypto || !dependencies.documentVault || !dependencies.dataRoot || !dependencies.backupRoot) return jsonError(context, 'UNAVAILABLE', '清除服務目前無法使用。', 503);
    const caseId = resolveCaseId(database, context.req.param('caseId'));
    if (!caseId) return jsonError(context, 'NOT_FOUND', '找不到這筆案件。', 404);
    try { return context.json({ data: previewPassportPurge({ database, crypto: dependencies.crypto, documentVault: dependencies.documentVault, dataRoot: dependencies.dataRoot, backupRoot: dependencies.backupRoot }, caseId) }); }
    catch (error) { return purgeError(context, error); }
  });

  app.post('/admin/v1/data/passports/:caseId/purge-authorizations', async (context) => {
    const auth = dependencies.csrfAuthenticated(context);
    if (!auth) return jsonError(context, 'CSRF_FAILED', '請重新登入。', 403);
    if (!dependencies.crypto || !dependencies.documentVault || !dependencies.dataRoot || !dependencies.backupRoot) return jsonError(context, 'UNAVAILABLE', '清除服務目前無法使用。', 503);
    if (!bodyAllowed(context)) return jsonError(context, 'PAYLOAD_TOO_LARGE', '請求內容過大。', 413);
    const body = await context.req.json().catch(() => null) as PurgeAuthorizationRequest | null;
    if (!body || typeof body.previewHash !== 'string' || typeof body.caseCode !== 'string' || typeof body.password !== 'string') return jsonError(context, 'INVALID_REQUEST', '確認資料不完整。', 400);
    const caseId = resolveCaseId(database, context.req.param('caseId'));
    if (!caseId) return jsonError(context, 'NOT_FOUND', '找不到這筆案件。', 404);
    try {
      const data = await authorizePassportPurge({ database, crypto: dependencies.crypto, documentVault: dependencies.documentVault, dataRoot: dependencies.dataRoot, backupRoot: dependencies.backupRoot }, { caseId, adminId: auth.adminId, ...body });
      return context.json({ data }, 201);
    } catch (error) { return purgeError(context, error); }
  });

  app.post('/admin/v1/data/passports/:caseId/purge', async (context) => {
    const auth = dependencies.csrfAuthenticated(context);
    if (!auth) return jsonError(context, 'CSRF_FAILED', '請重新登入。', 403);
    if (!dependencies.crypto || !dependencies.documentVault || !dependencies.dataRoot || !dependencies.backupRoot) return jsonError(context, 'UNAVAILABLE', '清除服務目前無法使用。', 503);
    const body = await context.req.json().catch(() => null) as { token?: string } | null;
    if (typeof body?.token !== 'string') return jsonError(context, 'INVALID_REQUEST', '刪除授權不完整。', 400);
    const caseId = resolveCaseId(database, context.req.param('caseId'));
    if (!caseId) return jsonError(context, 'NOT_FOUND', '找不到這筆案件。', 404);
    try {
      const data = await executePassportPurge({ database, crypto: dependencies.crypto, documentVault: dependencies.documentVault, dataRoot: dependencies.dataRoot, backupRoot: dependencies.backupRoot }, { caseId, adminId: auth.adminId, token: body.token });
      return context.json({ data });
    } catch (error) { return purgeError(context, error); }
  });

  return app;
}
