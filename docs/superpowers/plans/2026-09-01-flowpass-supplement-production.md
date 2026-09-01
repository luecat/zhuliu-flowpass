# FlowPass Supplement Production Implementation Plan

> **For agentic workers:** Execute inline in the current authorized dirty workspace. Do not delegate or create another worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a complete applicant supplement flow, replace demo naming, and remove user-visible draft behavior.

**Architecture:** Extend the applicant-safe task projection to include decrypted instructions, add a focused supplement panel to the existing case detail, and reuse the current document upload and task-completion endpoints. Keep `draft` only as an internal pre-submission state while excluding it from records and replacing older unsubmitted cases transactionally.

**Tech Stack:** Next.js App Router, React, TypeScript, SQLite, Vitest

**Spec:** `docs/superpowers/specs/2026-09-01-flowpass-supplement-production-design.md`

## Global Constraints

- Do not use TDD; implement first and run existing verification afterward.
- Do not expose internal task, state, case-code, or encrypted fields to applicants.
- Preserve unrelated dirty-work changes.
- Do not resurrect a standalone task-list page.

---

### Task 1: Applicant-safe supplement contract

**Files:**
- Modify: `server/db/repositories/tasks.ts`
- Modify: `server/domain/task-service.ts`
- Modify: `app/api/v1/tasks/route.ts`
- Modify: `app/api/v1/tasks/[taskId]/complete/route.ts`

**Interfaces:**
- Produces: applicant task records with `instructions: string` decrypted only after ownership checks.
- Produces: completion event copy `補件已送出` for `provide_document`.

- [ ] Extend the applicant query and mapper to decrypt `instructions_enc` with the runtime field crypto.
- [ ] Keep task listing scoped to the authenticated applicant and requested case.
- [ ] Replace the public completion timeline summary with natural applicant-facing copy.
- [ ] Run focused task and authorization tests after implementation.

### Task 2: Inline supplement experience

**Files:**
- Create: `app/components/public/supplement-panel.tsx`
- Modify: `app/components/public/applicant-case-detail.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `GET /api/v1/tasks?caseId=...`, document upload API, and task completion API.
- Produces: `SupplementPanel({ caseId, onCompleted })`.

- [ ] Load the open `provide_document` request only when the case needs documents.
- [ ] Render title, instructions, due date, requested file choices, upload status, and a single `送出補件` action without task terminology.
- [ ] Require a ready upload from the current supplement session before completion.
- [ ] Refresh the case detail after completion so the state becomes `resubmitted`.
- [ ] Add responsive styling consistent with the current applicant cards.

### Task 3: Remove demo naming and draft product behavior

**Files:**
- Create: `server/db/migrations/008_production_program_name.sql`
- Modify: `server/db/schema.test.ts`
- Modify: `server/domain/program-service.ts`
- Modify: `server/domain/case-service.ts`
- Modify: `server/db/repositories/cases.ts`
- Modify: `app/api/v1/passports/route.ts`
- Modify: `app/components/public/application-wizard.tsx`

**Interfaces:**
- Produces: public program name `軟體補助申請`.
- Produces: case creation that soft-deletes older owned `draft` cases before insert.
- Produces: applicant record queries that exclude `draft` and soft-deleted cases.

- [ ] Add a migration that renames existing demo program cycles and removes demo rule metadata.
- [ ] Change new program bootstrap values to production naming.
- [ ] Exclude draft cases from applicant record queries.
- [ ] Remove draft resume logic and all user-facing draft copy from the application wizard.
- [ ] Preserve direct `caseId` continuation only for the active application handoff inside the same flow.

### Task 4: Verification and release

**Files:**
- Modify only tests whose assertions intentionally encode removed demo/draft copy.

- [ ] Run focused component, route, service, repository, migration, and authorization tests.
- [ ] Run the complete existing test suite.
- [ ] Run the production build and package-release checks.
- [ ] Deploy the release through the existing launch-agent workflow.
- [ ] Verify local services, public health, application records, and the deployed build identifier.
