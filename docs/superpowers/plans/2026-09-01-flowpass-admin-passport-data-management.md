# FlowPass 單一護照資料管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可上正式環境的單一護照資料檢視、白名單欄位覆寫與完整關聯資料清除功能。

**Architecture:** 後台以型別化快照服務呈現完整關聯圖，所有寫入由固定欄位 registry 執行，進階原始模式保持唯讀。永久清除由專用協調器在跨 runtime 維護鎖下執行，使用簽章預覽、一次性密碼授權、精確刪除順序、附件隔離與已驗證備份避免半套資料。

**Tech Stack:** TypeScript 5.9、Hono、React 19、better-sqlite3、SQLite migrations、Vitest、Testing Library、tsup

**Spec:** `docs/superpowers/specs/2026-09-01-flowpass-admin-passport-data-management-design.md`

## Global Constraints

- 不提供任意 SQL，也不接受前端控制資料表、欄位、JOIN、WHERE 或檔案路徑。
- 修改採直接覆寫；ID、外鍵、擁有者、版本、雜湊、加密及系統結構欄位鎖定。
- 清除只限單一護照與其一對一案件；保留申請人及其其他護照。
- 清除包含資料庫關聯紀錄、附件檔案及可能含目標資料的 FlowPass 管理備份。
- 三階段確認必須包含精確預覽、完整案件編號及目前管理員密碼。
- 按使用者要求不採 TDD；先完成每項實作，再補針對性測試與完整驗證。
- 保留工作目錄中所有既有未提交修改；提交只包含本功能檔案。

---

### Task 1: 資料管理契約、migration 與維護鎖

**Files:**
- Create: `shared/admin-data-management-contract.ts`
- Create: `server/db/migrations/009_admin_data_management.sql`
- Create: `server/services/maintenance-mode.ts`
- Modify: `server/public/runtime.ts`
- Modify: `server/worker/main.ts`
- Test after implementation: `server/services/maintenance-mode.test.ts`
- Test after implementation: `server/db/schema.test.ts`

**Interfaces:**
- Produces: `AdminPassportDataSnapshot`, `AdminDataRecord`, `AdminDataField`, `AdminFieldPatch`, `PurgePreview`, `PurgeAuthorizationRequest`, `PurgeResult`.
- Produces: `isMaintenanceMode(database): boolean`, `acquireMaintenanceMode(database, operationId, now): void`, `releaseMaintenanceMode(database, operationId): void`.
- Migration creates singleton `flowpass_maintenance_state`, `admin_data_edit_audits` and `admin_purge_authorizations` with hashed one-use tokens and five-minute expiry.

- [ ] **Step 1: Define the shared contract**

```ts
export interface AdminDataField {
  key: string;
  label: string;
  type: 'text' | 'integer' | 'money' | 'date' | 'datetime' | 'boolean' | 'json' | 'status';
  value: unknown;
  editable: boolean;
  lockedReason?: string;
}

export interface AdminDataRecord {
  resource: string;
  table: string;
  id: string;
  parentId?: string;
  rowVersion?: number;
  kind: 'source' | 'derived' | 'history' | 'system';
  fields: AdminDataField[];
}
```

- [ ] **Step 2: Add migration 009**

Create the singleton maintenance row with `active`, `operation_id`, `started_at`, and `phase`; create edit audit rows without old/new sensitive values; create purge authorization rows containing `token_hash`, `admin_user_id`, `case_id`, `preview_hash`, `expires_at`, and `consumed_at`.

- [ ] **Step 3: Implement maintenance helpers and runtime gates**

`getPublicRuntime()` returns `null` while maintenance is active. The worker tick checks `isMaintenanceMode(database)` before enqueueing or leasing work. The admin app continues to serve health and the data-management operation that owns the lock.

- [ ] **Step 4: Add post-implementation tests**

Verify migration 009 applies cleanly, a non-owner cannot replace an active lock, only the owner can release it, public runtime returns unavailable during maintenance, and worker dispatch is skipped while locked.

- [ ] **Step 5: Run focused validation**

Run: `npm test -- server/services/maintenance-mode.test.ts server/db/schema.test.ts server/public/runtime.test.ts server/worker/queue-dispatcher.test.ts`

Expected: all selected tests pass.

### Task 2: 完整護照資料快照與安全原始檢視

**Files:**
- Create: `server/db/admin-passport-relation-registry.ts`
- Create: `server/services/admin-passport-data-service.ts`
- Test after implementation: `server/services/admin-passport-data-service.test.ts`

**Interfaces:**
- Consumes: shared snapshot contract and `FieldCrypto`.
- Produces: `getAdminPassportDataSnapshot(database, crypto, caseId): AdminPassportDataSnapshot | null`.
- Produces: `collectPassportRelationGraph(database, caseId): PassportRelationGraph | null`, reused by purge.

- [ ] **Step 1: Define the fixed relation registry**

The registry explicitly resolves case, applicant reference, passport, versions, answers, purchase details, documents, OCR, document fields/reviews, fingerprints, confirmations, follow-ups, indices, evaluations, calculations, tasks, notifications, transitions, timeline, AI, alerts, incident matches, jobs, audit entity rows, idempotency rows and safely attributable LINE/webhook rows.

- [ ] **Step 2: Implement decrypted snapshot mapping**

Use fixed SQL and exact encrypted-field AAD contexts already used by repositories. Return Chinese labels and logical values in the grouped records. Return storage metadata such as hashes, byte sizes and key IDs only as locked fields; never return ciphertext, master keys, session tokens or password hashes.

- [ ] **Step 3: Implement relation classification**

Mark editable source records, read-only derived records, immutable history and system metadata. Include applicant and LINE identity summaries as shared read-only context, but exclude them from the purge graph.

- [ ] **Step 4: Add post-implementation tests**

Seed two passports for the same applicant. Verify the selected snapshot includes all target records, decrypts expected values, excludes secrets/ciphertext, and does not include the second passport's records.

- [ ] **Step 5: Run focused validation**

Run: `npm test -- server/services/admin-passport-data-service.test.ts`

Expected: all snapshot and isolation tests pass.

### Task 3: 白名單單欄覆寫與相依資料一致性

**Files:**
- Create: `server/services/admin-passport-edit-service.ts`
- Modify: `server/db/repositories/passports.ts`
- Modify: `server/db/repositories/cases.ts`
- Test after implementation: `server/services/admin-passport-edit-service.test.ts`

**Interfaces:**
- Consumes: `AdminFieldPatch`, `FieldCrypto`, `expectedRowVersion`.
- Produces: `editAdminPassportField(input): { rowVersion: number; requiresAiRefresh: boolean; recalculated: string[] }`.
- Produces: server-owned `ADMIN_EDITABLE_FIELDS` registry whose handlers never interpolate user input into SQL identifiers.

- [ ] **Step 1: Implement the field registry**

Provide typed handlers for current answer values, purchase details, allowed case fields, allowed passport payload paths, task fields, alert public fields, timeline public fields and document display name. Reject all unknown resources, fields and structural keys.

- [ ] **Step 2: Implement atomic direct overwrite**

Validate `expectedRowVersion`, parse the value by declared type, re-encrypt sensitive records, update content hashes and increment row versions in one transaction. Append `admin_data_edit_audits` with admin, resource, record, field, type, request ID and outcome only.

- [ ] **Step 3: Reconcile deterministic dependencies**

For answer, purchase or passport payload changes, rebuild current passport indexes with the existing payload parser/index insertion logic, rerun existing deterministic rule and subsidy services when their required inputs exist, and set an `requires_ai_refresh` edit audit marker without calling the model.

- [ ] **Step 4: Add post-implementation tests**

Verify successful encrypted overwrite, stale row conflict, structural-field rejection, invalid type rejection, hash change, index rebuild, deterministic amount update and audit rows that do not contain old/new sensitive values.

- [ ] **Step 5: Run focused validation**

Run: `npm test -- server/services/admin-passport-edit-service.test.ts server/db/repositories/sensitive-persistence.test.ts`

Expected: all selected tests pass.

### Task 4: 預覽、一次性授權與單一護照完整清除

**Files:**
- Create: `server/services/admin-passport-purge-service.ts`
- Modify: `server/services/document-vault.ts`
- Modify: `scripts/backup.ts`
- Test after implementation: `server/services/admin-passport-purge-service.test.ts`

**Interfaces:**
- Consumes: `collectPassportRelationGraph`, `DocumentVault`, admin password verifier, `dataRoot`, `backupRoot`.
- Produces: `previewPassportPurge(input): PurgePreview`.
- Produces: `authorizePassportPurge(input): Promise<{ token: string; expiresAt: string }>`.
- Produces: `executePassportPurge(input): Promise<PurgeResult>`.
- Produces: `DocumentVault.quarantine(refs, operationId)`, `restoreQuarantine`, `purgeQuarantine` using validated storage IDs only.

- [ ] **Step 1: Implement signed preview generation**

Hash the canonical target graph, row versions, attachment hashes and current FlowPass backup directory list. Return exact table counts, IDs, attachment bytes, backups and preserved sibling count.

- [ ] **Step 2: Implement password-backed one-use authorization**

Require exact case code and current admin password. Store only the authorization token hash, bind it to admin/case/preview hash, expire after five minutes and atomically consume it once.

- [ ] **Step 3: Implement vault quarantine and verified backups**

Move only validated storage IDs to an operation-specific quarantine directory. Add a backup helper that accepts an existing database connection, writes a manifest and verifies SHA-256 plus SQLite integrity before returning.

- [ ] **Step 4: Implement the purge coordinator**

Acquire maintenance mode, reject execution while any job is leased, verify the preview has not changed, create a temporary pre-purge backup, quarantine attachments, delete the explicit relation graph in dependency order inside `BEGIN IMMEDIATE`, verify no target remnants and sibling invariants, commit, create a clean verified backup, purge old backups and quarantine, rescan, then release maintenance.

- [ ] **Step 5: Implement failure recovery**

Before commit, roll back and restore quarantined files. After commit but before final cleanup, restore the temporary database and attachments while maintenance remains active. Never report success until database, vault and FlowPass backup scans all pass.

- [ ] **Step 6: Add post-implementation tests**

Seed a complete graph plus a sibling passport. Verify preview counts, wrong password and wrong case code rejection, token expiry/reuse rejection, complete target removal, sibling preservation, physical blob removal, backup replacement and injected failures before and after commit.

- [ ] **Step 7: Run focused validation**

Run: `npm test -- server/services/admin-passport-purge-service.test.ts scripts/backup.test.ts scripts/restore-check.test.ts`

Expected: all purge, recovery and backup tests pass.

### Task 5: 後台路由與正式安全邊界

**Files:**
- Create: `server/admin/routes/data-management.ts`
- Modify: `server/admin/app.ts`
- Modify: `server/admin/main.ts`
- Test after implementation: `server/admin/data-management.test.ts`

**Interfaces:**
- Consumes: snapshot, edit and purge services.
- Produces: the seven `/admin/v1/data/...` endpoints defined by the spec.

- [ ] **Step 1: Mount authenticated read and mutation routes**

Reuse the existing request boundary, admin session and CSRF middleware. Inject `crypto`, `documentVault`, `dataRoot` and `backupRoot` from trusted startup composition; return 503 when a required dependency is absent.

- [ ] **Step 2: Map stable errors**

Return stable codes for not found, invalid request, locked field, row conflict, password rejection, expired preview, maintenance conflict, recovery active and purge failure. Do not return SQL, paths or stack traces.

- [ ] **Step 3: Add post-implementation route tests**

Verify read authorization, CSRF on every mutation, no-cache headers, mutation body limits, missing crypto/vault fail-closed, remote boundary handling and service error mappings.

- [ ] **Step 4: Run focused validation**

Run: `npm test -- server/admin/data-management.test.ts server/admin/app.test.ts server/admin/attachments.test.ts`

Expected: all selected admin tests pass.

### Task 6: 資料管理 UI 與可用性

**Files:**
- Create: `admin/data-manager.tsx`
- Create: `admin/data-manager.css`
- Modify: `admin/main.tsx`
- Modify: `admin/admin.css`
- Test after implementation: `admin/data-manager.test.tsx`
- Modify after implementation: `admin/main.test.tsx`

**Interfaces:**
- Consumes: shared admin data-management contract and `/admin/v1/data/...` endpoints.
- Produces: full-page `DataManager` with grouped view, raw view, search, single-field editor and purge confirmation dialog.

- [ ] **Step 1: Add the case-list entry and full-page shell**

Each case row gains a clear「資料管理」button. The full-page view shows case code, Chinese status, updated time and back navigation without exposing raw status in normal mode.

- [ ] **Step 2: Implement grouped and raw read views**

Render the nine approved groups, field provenance, editability and search. Raw mode shows table/column/type/rowVersion and storage metadata as read-only code-style rows.

- [ ] **Step 3: Implement single-field editing**

Use an explicit edit button, typed input, preview of recalculated effects, CSRF mutation, conflict recovery and Chinese validation messages. Never turn the full raw table into an editable grid.

- [ ] **Step 4: Implement the three-stage purge dialog**

Stage one renders table counts, IDs, attachment bytes, backups and preserved siblings. Stage two requires exact case code. Stage three requires the current password, obtains the one-use token and executes while showing maintenance/recovery state. Destructive action stays disabled until all checks pass.

- [ ] **Step 5: Add responsive, accessible styling**

Use visible focus rings, labeled controls, keyboard-operable tabs/dialog, 44px minimum action height, non-color-only warnings, responsive single-column mobile layout and no horizontal overflow at 360px.

- [ ] **Step 6: Add post-implementation UI tests**

Verify group rendering, raw read-only mode, search, edit request shape, row conflict, all purge gates, loading/error states and back navigation.

- [ ] **Step 7: Run focused validation**

Run: `npm test -- admin/data-manager.test.tsx admin/main.test.tsx`

Expected: all selected UI tests pass.

### Task 7: 整體驗證、封裝與發布前檢查

**Files:**
- Modify only if verification finds an implementation defect in files already listed above.

**Interfaces:**
- Consumes: complete feature from Tasks 1-6.
- Produces: verified release candidate; does not execute a real production purge.

- [ ] **Step 1: Run static checks**

Run: `npm run typecheck && npm run lint`

Expected: both commands exit successfully with no new errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all tests pass; record exact file and test counts.

- [ ] **Step 3: Build fresh admin and release artifacts**

Run: `npm run build:admin && npm run build:release`

Expected: both builds succeed and include the data manager assets and migration 009.

- [ ] **Step 4: Perform non-destructive live smoke checks**

Verify admin login, case list, data snapshot, grouped/raw switching and purge preview against the configured local runtime. Do not submit the final purge action against production data.

- [ ] **Step 5: Review the final diff**

Confirm only this feature's files are staged, all existing unrelated dirty files remain untouched, no secret/path/ciphertext appears in client bundles or logs, and no destructive operation ran against the live database.
