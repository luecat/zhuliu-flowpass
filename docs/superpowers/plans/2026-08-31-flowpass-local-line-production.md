# FlowPass Local LINE Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing FlowPass local SQLite application usable from LINE LIFF through the production HTTPS domain, with a trusted startup composition and restart-safe local services.

**Architecture:** Keep SQLite, FieldCrypto, macOS Keychain, and the existing Next API routes on the Mac. Add a public-runtime bootstrap imported by Next server instrumentation, then run the public server, admin service, worker, and Daniel Cloudflare Tunnel from one release-managed launchd setup. LUECAT D1 remains provisioned but unused in this phase.

**Tech Stack:** Next.js 16, Node.js 22, Hono, better-sqlite3, `@line/liff`, macOS Keychain, launchd, cloudflared.

**Spec:** `docs/superpowers/specs/2026-08-31-flowpass-local-line-production-design.md`

## Global Constraints

- Public origin is exactly `https://flowpass.luecat.com`.
- LINE Login Channel ID is `2011336492`; LIFF ID is `2011336492-ay7OJ4mO`.
- Channel Secret and master encryption key remain Keychain-only.
- SQLite remains the authoritative data store; no D1 repository rewrite.
- Do not write secrets, cookies, raw LINE subjects, or database data to Git, DNS, or frontend bundles.
- Preserve existing unrelated `package-lock.json` and `tsconfig.tsbuildinfo` working-tree changes.

### Task 1: Public runtime startup composition

**Files:**
- Create: `server/public/bootstrap.ts`
- Create: `server/public/bootstrap.test.ts`
- Create: `instrumentation.ts`
- Modify: `server/public/runtime.ts`
- Modify: `server/config/runtime-config.ts`

**Interfaces:**
- `createPublicRuntime(options?: { provider?: SecretProvider; database?: FlowPassDatabase; clock?: () => Date }): Promise<PublicRuntime>` loads the migrated database, FieldCrypto, SessionService, LineLoginClient, LineSessionService, and DocumentVault.
- `bootstrapPublicRuntime(): Promise<void>` configures the singleton once and fails closed when required secrets are absent.

- [ ] Write tests proving complete composition configures runtime and missing LINE Channel Secret returns a deterministic unavailable state without exposing secret values.
- [ ] Implement Keychain-backed startup using `FLOWPASS_LINE_CHANNEL_SECRET`, `FLOWPASS_LINE_CHANNEL_SECRET_KEYCHAIN_ACCOUNT`, active master key refs, and `runtimeConfig`.
- [ ] Add `instrumentation.ts` `register()` that awaits bootstrap only in the Node production server phase and skips build-time execution.
- [ ] Run `npm test -- server/public/bootstrap.test.ts server/config/runtime-config.test.ts`.

### Task 2: LINE production configuration and local persistence

**Files:**
- Modify: `scripts/configure-local.ts`
- Modify: `scripts/set-secret.ts`
- Modify: `scripts/render-cloudflared-config.ts`
- Create: `scripts/line-production-check.ts`
- Test: `scripts/configure-local.test.ts`, `scripts/install-launch-agents.test.ts`

**Interfaces:**
- `configureLocal` writes only non-secret production values, including the exact public origin, Channel ID, and LIFF ID.
- `line-production-check` reports configuration presence and endpoint checks without printing secret values.

- [ ] Add non-secret config assertions for `https://flowpass.luecat.com`, `2011336492`, and `2011336492-ay7OJ4mO`.
- [ ] Add a Keychain binding path for the LINE Channel Secret and retain existing generic secret behavior.
- [ ] Make tunnel config render Daniel Tunnel `06a57a58-4a96-4fa1-9486-76734660374f` and `flowpass.luecat.com` without embedding credentials.
- [ ] Add a check that verifies public page 200 and expected API auth failure responses, never raw secret output.
- [ ] Run focused script/config tests.

### Task 3: Release packaging and restart-safe launchd services

**Files:**
- Modify: `scripts/package-release.ts`
- Modify: `scripts/install-launch-agents.ts`
- Modify: `ops/launchd/launch-agent-contract.ts`
- Create: `scripts/production-start.ts`
- Test: `scripts/package-release.test.ts`, `scripts/install-launch-agents.test.ts`

**Interfaces:**
- `production-start` starts the built public server with the same release/data-root environment used by admin and worker services.
- launchd labels remain `com.luecat.flowpass.public`, `admin`, `worker`, `tunnel`, and `backup`.

- [ ] Package the Next standalone server, static assets, server bundles, and tunnel config into an atomic release without copying data/vault/backups.
- [ ] Replace the public launch-agent entry from a missing `server/public.mjs` to the production start wrapper that runs `.next/standalone/server.js` with the configured origin.
- [ ] Ensure launch agents use absolute Node/cloudflared paths, `RunAtLoad`, `KeepAlive`, and secure log paths.
- [ ] Add dry-run tests for generated arguments and release manifest coverage.
- [ ] Run package and launch-agent focused tests.

### Task 4: Real LINE flow and end-to-end verification

**Files:**
- Modify: `app/components/public/application-wizard.tsx`
- Create: `app/components/public/application-wizard.production.test.tsx`
- Create: `docs/superpowers/reports/2026-08-31-flowpass-local-line-production-report.md`

**Interfaces:**
- Wizard uses the existing LIFF bootstrap/exchange/current-program/case/answers API sequence and exposes saving, conflict, and unavailable states.
- Production report records exact command outputs, URLs, account ownership, and remaining limitations.

- [ ] Add tests for production-origin LIFF initialization, bootstrap cookie, exchange, case creation, and answer autosave without sending secrets.
- [ ] Keep missing LIFF configuration visibly pending and prevent network writes in local preview.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build:public`.
- [ ] Install/update local release and launch agents, start public/admin/worker/tunnel services, and verify `/app/apply` over HTTPS.
- [ ] Execute the LINE LIFF smoke test with the user-provided Channel Secret entered interactively into Keychain; record whether login and draft creation succeed.

### Task 5: Handoff and safety checks

**Files:**
- Modify: `docs/runbook.md`
- Modify: `docs/acceptance-evidence.md`

- [ ] Document start/stop/status commands, Keychain secret names, and the fact that Mac uptime is required.
- [ ] Document that LUECAT D1 is provisioned but intentionally unused until a separate D1 migration is approved.
- [ ] Run final health checks and ensure no secrets or database files are staged.
