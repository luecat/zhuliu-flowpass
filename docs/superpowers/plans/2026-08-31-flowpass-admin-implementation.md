# FlowPass Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working local and Cloudflare-protected FlowPass admin with secure bootstrap login, forced password change, password recovery, and a functional case-management UI.

**Architecture:** Keep the Admin process loopback-only on port 38101. Cloudflare Tunnel adds an exact admin hostname, while the app accepts either the exact loopback origin or a cryptographically validated Cloudflare Access JWT for the one approved email. SQLite remains authoritative for users, sessions, password history, lockout, and short-lived recovery challenges.

**Tech Stack:** TypeScript, Hono, React 19, Vite, SQLite/better-sqlite3, Vitest, tsup, cloudflared.

**Spec:** `../specs/2026-08-31-flowpass-admin-access-design.md`

## Global Constraints

- Work in the existing dirty checkout and preserve all unrelated user changes.
- Do not commit, push, delete, or rewrite existing data.
- Bootstrap credentials are exactly `admin/admin`; they must force an immediate password change.
- New passwords are 8–128 Unicode code points and must contain ASCII uppercase, lowercase, digit, and symbol.
- Lock after 5 failed logins for 15 minutes; keep the most recent 3 password hashes unavailable for reuse.
- Recovery identity is exactly `daniel0104.sung@gmail.com`; recovery tokens last 10 minutes and are single-use.
- Remote requests require a verified Cloudflare Access assertion. Local requests require exact loopback Host and Origin.
- Tests must be written and observed failing before production implementation.

---

### Task 1: Authentication, password lifecycle, and Admin API

**Files:**
- Create: `server/db/migrations/004_admin_security.sql`
- Create: `server/admin/auth/admin-account.ts`
- Create: `server/admin/auth/admin-account.test.ts`
- Modify: `server/admin/auth/password.ts`
- Modify: `server/admin/auth/password.test.ts`
- Modify: `server/admin/auth/admin-session.ts`
- Modify: `server/admin/app.ts`
- Modify: `server/admin/app.test.ts`
- Modify: `scripts/bootstrap-admin.ts`

**Interfaces:**
- Produces `validateAdminPassword(password, identity): { valid: boolean; errors: string[] }`.
- Produces account operations for login failure accounting, password change, recovery challenge creation/consumption, and session revocation.
- Produces `GET /admin/v1/session`, `POST /admin/v1/sessions`, `DELETE /admin/v1/sessions/current`, `POST /admin/v1/password/change`, `POST /admin/v1/password-recovery/start`, and `POST /admin/v1/password-recovery/complete`.
- Session/login JSON includes `mustChangePassword`; protected data routes reject sessions whose account still requires a password change.
- Recovery start accepts only an already verified access identity injected by the origin guard; no email supplied by the browser is trusted.

- [ ] **Step 1: Write failing behavior tests**

Add literal boundary cases for `Aa1!aaaa` passing, missing each character class failing, seven code points failing, username/email fragments failing, and recent hashes failing. Add route tests for forced change, five-attempt lockout, CSRF, password change revocation, recovery expiry, single use, and generic errors.

- [ ] **Step 2: Verify RED**

Run: `npm test -- server/admin/auth/password.test.ts server/admin/auth/admin-account.test.ts server/admin/app.test.ts`

Expected: FAIL because the migration, lifecycle functions, and routes do not exist.

- [ ] **Step 3: Implement the minimum secure lifecycle**

Create additive migration columns/tables, a versioned salted scrypt encoder, transaction-backed account operations, cookie helpers for local versus HTTPS, CSRF verification, and the specified routes. Seed `admin/admin` only when the operator explicitly runs bootstrap and never overwrite an existing account.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- server/admin/auth/password.test.ts server/admin/auth/admin-account.test.ts server/admin/app.test.ts server/db/schema.test.ts`

Expected: PASS.

### Task 2: Functional React Admin UI

**Files:**
- Create: `admin/admin.css`
- Modify: `admin/main.tsx`

**Interfaces:**
- Consumes the Task 1 JSON routes and sends `X-CSRF-Token` from the non-HttpOnly CSRF cookie for mutations.
- Login response/session state: `{ authenticated, displayName, mustChangePassword, passwordExpiresAt? }`.
- Cases response remains `{ data: { cases: Array<{ id, case_code, state, submitted_at, updated_at, row_version }> } }`.

- [ ] **Step 1: Write failing UI tests only if a current UI harness is available**

When a jsdom React test can be added without new dependencies, prove login, forced-password form, case loading, logout, and forgot-password states. Otherwise keep this as a compiled UI integration and cover API behavior in Task 1.

- [ ] **Step 2: Verify RED when tests were added**

Run: `npm test -- admin`

Expected: FAIL because the current one-line placeholder lacks the states.

- [ ] **Step 3: Implement the admin shell**

Build accessible login, password change, recovery, dashboard/case queue, state filters, refresh, logout, security notice, loading, empty, and generic error states. Default the account field to `admin`, never embed a password, never render secrets, and make the narrow-screen layout usable.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build:admin && npm run typecheck`

Expected: both exit 0.

### Task 3: Release packaging and Tunnel ingress

**Files:**
- Modify: `scripts/package-release.test.ts`
- Modify: `scripts/package-release.ts`
- Modify: `scripts/render-cloudflared-config.test.ts`
- Modify: `scripts/render-cloudflared-config.ts`
- Modify only if required: `tsup.config.ts`

**Interfaces:**
- Release contains `admin/index.html`, Admin assets, bundled `server/admin.mjs`, migrations through `004_admin_security.sql`, and the required native SQLite dependency.
- Tunnel config ordering is public hostname -> 38100, admin hostname -> 38101, catch-all 404.

- [ ] **Step 1: Write failing packaging and ingress tests**

Assert the release contains Admin assets and migration 004, and assert the rendered YAML contains both exact hostnames in order followed by the catch-all.

- [ ] **Step 2: Verify RED**

Run: `npm test -- scripts/package-release.test.ts scripts/render-cloudflared-config.test.ts`

Expected: FAIL because the Admin ingress and new migration assertions are absent from production behavior.

- [ ] **Step 3: Implement minimal packaging/config changes**

Preserve the existing tunnel ID and credential permission checks. Add only the exact Admin ingress and make packaging/runtime paths independent of LaunchAgent working directory.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- scripts/package-release.test.ts scripts/render-cloudflared-config.test.ts && npm run build:bundles`

Expected: PASS and `dist/server/admin.mjs` has no unresolved `@hono/node-server` import.

### Task 4: Integrate, bootstrap, run, and verify

**Files:**
- Modify generated runtime/release artifacts only through existing project scripts.
- Do not modify secrets files or Cloudflare account state without first reading current state.

**Interfaces:**
- Consumes Tasks 1–3.
- Produces local evidence from `/healthz`, login, forced change, case route, and release restart.
- Produces remote evidence when current Cloudflare credentials authorize DNS/Access changes.

- [ ] **Step 1: Run focused and project checks**

Run: `npm test -- server/admin scripts/package-release.test.ts scripts/render-cloudflared-config.test.ts`, `npm run typecheck`, `npm run build:admin`, and `npm run build:bundles`.

- [ ] **Step 2: Render and validate Tunnel config**

Run the project renderer, then `cloudflared tunnel ingress validate` and rule checks for both hostnames. Never print tunnel credentials.

- [ ] **Step 3: Package and restart locally**

Use the existing release and LaunchAgent scripts. Bootstrap the account only if absent. Verify `http://127.0.0.1:38101/healthz` and the actual login/forced-change behavior against a disposable database first, then the configured runtime.

- [ ] **Step 4: Configure and verify Cloudflare Access when authorized**

Reuse the existing tunnel and zone. Add the Admin DNS route and a self-hosted Access application whose policy includes exactly `daniel0104.sung@gmail.com` with Email OTP. Verify unauthenticated blocking and the permitted identity flow. If account/API authorization is unavailable, report this as an external deployment blocker without weakening the app.

- [ ] **Step 5: Final regression check**

Verify the public service on 38100 still responds, review the scoped diff for secrets/unrelated changes, and report local, release, Tunnel, Access, and remote evidence separately.
