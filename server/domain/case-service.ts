import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FieldCrypto } from '../crypto/field-crypto';
import { decryptDatabaseText, encryptDatabaseText } from '../db/repositories/encrypted-fields';
import type { FlowPassDatabase } from '../db/connection';
import { appendEncryptedAuditLog } from '../db/repositories/audit';
import { getCaseForApplicant } from '../db/repositories/cases';
import { insertEncryptedPassportVersionForSystem } from '../db/repositories/passports';
import { deleteApplicantMutationReservation, finalizeApplicantMutation, reserveApplicantMutation } from '../public/public-mutations';
import { parseQuotedEtag } from '../../shared/api-contract';
import { validateCoreAnswers, validateDraftCoreAnswers, serializeCoreAnswers, type CoreAnswers } from '../../shared/case-contract';
import { inspectPassportDocument } from './passport-validation';
import type { FlowPassPassport } from '../../shared/passport-contract';

export class CaseCommandError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'ETAG_MISMATCH' | 'INVALID_STATE' | 'INVALID_REQUEST' | 'IDEMPOTENCY_KEY_REUSED', message: string = code) {
    super(message);
    this.name = 'CaseCommandError';
  }
}

type IdGenerator = () => string;
type PublicCase = ReturnType<typeof getCaseForApplicant> extends infer T ? Exclude<T, null> : never;

function hashAnswers(answers: CoreAnswers): string {
  return createHash('sha256').update(serializeCoreAnswers(answers), 'utf8').digest('hex');
}

function replayData<T extends object>(value: string, required: keyof T): T {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Idempotency replay is invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !(required in parsed)) throw new Error('Idempotency replay is unavailable');
  return parsed as T;
}

function latestVersion(database: FlowPassDatabase, caseId: string): number {
  const row = database.prepare('SELECT COALESCE(MAX(version_no), 0) AS version FROM answer_versions WHERE case_id = ?').get(caseId) as { version: number };
  return row.version;
}

function nextSequence(database: FlowPassDatabase, caseId: string): number {
  const row = database.prepare('SELECT COALESCE(MAX(sequence_no), 0) AS sequence FROM timeline_events WHERE case_id = ?').get(caseId) as { sequence: number };
  return row.sequence + 1;
}

export interface CaseService {
  findActiveDraft(applicantId: string): PublicCase | null;
  create(input: { applicantId: string; programCycleId: string; idempotencyKey: string; requestId?: string; reuseFromCaseId?: string | null }): { case: PublicCase; reused: boolean };
  saveAnswers(input: { applicantId: string; caseId: string; answers: CoreAnswers; ifMatch: string; idempotencyKey: string; requestId?: string }): { case: PublicCase; answerVersion: { id: string; versionNo: number; createdAt: string } };
}

export interface CaseServiceOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  clock?: () => Date;
  idGenerator?: IdGenerator;
  requestIdGenerator?: IdGenerator;
}

export function createCaseService(options: CaseServiceOptions): CaseService {
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? uuidv7;
  const requestIdGenerator = options.requestIdGenerator ?? uuidv7;
  const requestId = () => requestIdGenerator();

  function reserve(applicantId: string, method: string, route: string, key: string, projection: unknown, now: Date) {
    const reservation = reserveApplicantMutation({ database: options.database, crypto: options.crypto, applicantId, method, normalizedRoute: route, idempotencyKey: key, requestProjection: projection, now });
    if (reservation.kind === 'conflict') throw new CaseCommandError('IDEMPOTENCY_KEY_REUSED');
    if (reservation.kind === 'replay') return reservation;
    return reservation;
  }

  return {
    findActiveDraft(applicantId) {
      const row = options.database.prepare(`
        SELECT id FROM cases
        WHERE applicant_id = ? AND state = 'draft' AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1
      `).get(applicantId) as { id: string } | undefined;
      if (!row) return null;
      return getCaseForApplicant(options.database, { applicantId }, row.id);
    },

    create(input) {
      const now = clock();
      const reuseFromCaseId = input.reuseFromCaseId?.trim() || null;
      const requestProjection = reuseFromCaseId
        ? { programCycleId: input.programCycleId, reuseFromCaseId }
        : { programCycleId: input.programCycleId };
      const reservation = reserve(input.applicantId, 'POST', '/api/v1/cases', input.idempotencyKey, requestProjection, now);
      if (reservation.kind === 'replay') return replayData<{ case: PublicCase; reused: boolean }>(reservation.body, 'case');
      const createdAt = now.toISOString();
      const caseId = idGenerator();
      const caseCode = `FP-${createdAt.slice(0, 10).replaceAll('-', '')}-${caseId.slice(-8).toUpperCase()}`;
      let output!: { case: PublicCase; reused: boolean };
      try { options.database.transaction(() => {
        const program = options.database.prepare(`SELECT c.id AS cycle_id, r.id AS rule_id FROM program_cycles c JOIN program_rule_versions r ON r.program_cycle_id = c.id AND r.status = 'published' WHERE c.id = ? AND c.status = 'active' ORDER BY r.version_no DESC LIMIT 1`).get(input.programCycleId) as { cycle_id: string; rule_id: string } | undefined;
        if (!program) throw new CaseCommandError('INVALID_REQUEST', 'Program is unavailable');
        options.database.prepare(`UPDATE cases SET deleted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE applicant_id = ? AND state = 'draft' AND deleted_at IS NULL`).run(createdAt, createdAt, input.applicantId);
        options.database.prepare(`INSERT INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, 1)`).run(caseId, caseCode, input.applicantId, program.cycle_id, program.rule_id, createdAt, createdAt);
        options.database.prepare(`INSERT INTO case_state_transitions (id, case_id, sequence_no, from_state, to_state, reason_code, reason_enc, actor_type, actor_id, created_at) VALUES (?, ?, 1, NULL, 'draft', 'created', NULL, 'applicant', ?, ?)`).run(idGenerator(), caseId, input.applicantId, createdAt);

        let reused = false;
        if (reuseFromCaseId) {
          const source = options.database.prepare(`
            SELECT cases.id AS case_id,
                   cases.current_answer_version_id AS answer_id,
                   COALESCE(cases.submitted_passport_version_id, cases.current_passport_version_id) AS passport_version_id
            FROM cases
            WHERE cases.id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL
          `).get(reuseFromCaseId, input.applicantId) as { case_id: string; answer_id: string | null; passport_version_id: string | null } | undefined;
          if (!source?.answer_id || !source.passport_version_id) throw new CaseCommandError('INVALID_REQUEST', 'Reuse source is unavailable');
          const answerRow = options.database.prepare('SELECT answers_enc, content_sha256 FROM answer_versions WHERE id = ? AND case_id = ?').get(source.answer_id, source.case_id) as { answers_enc: string; content_sha256: string } | undefined;
          const passportRow = options.database.prepare('SELECT payload_enc, workflow_state, schema_version FROM passport_versions WHERE id = ?').get(source.passport_version_id) as { payload_enc: string; workflow_state: string; schema_version: string } | undefined;
          if (!answerRow || !passportRow || passportRow.workflow_state !== 'confirmed') throw new CaseCommandError('INVALID_REQUEST', 'Reuse source must be a confirmed passport');
          const answers = validateCoreAnswers(JSON.parse(decryptDatabaseText(options.crypto, 'answer_versions', 'answers_enc', source.answer_id, answerRow.answers_enc)));
          const passportPayload = JSON.parse(decryptDatabaseText(options.crypto, 'passport_versions', 'payload_enc', source.passport_version_id, passportRow.payload_enc)) as FlowPassPassport;
          const inspection = inspectPassportDocument({
            passport_draft: {
              ...passportPayload,
              follow_up_questions: [],
              audit: { ...passportPayload.audit, draft_status: 'ai_generated_unconfirmed' },
            },
          });
          if (!inspection.canonical) throw new CaseCommandError('INVALID_REQUEST', 'Reuse passport is invalid');
          const answerVersionId = idGenerator();
          const serializedAnswers = serializeCoreAnswers(answers);
          options.database.prepare('INSERT INTO answer_versions (id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)').run(
            answerVersionId,
            caseId,
            encryptDatabaseText(options.crypto, 'answer_versions', 'answers_enc', answerVersionId, serializedAnswers),
            createHash('sha256').update(serializedAnswers, 'utf8').digest('hex'),
            input.applicantId,
            createdAt,
          );
          const passportId = idGenerator();
          const passportVersionId = idGenerator();
          options.database.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(passportId, caseId, createdAt);
          const serializedPassport = JSON.stringify(inspection.canonical);
          insertEncryptedPassportVersionForSystem(options.database, { systemId: 'case-service' }, options.crypto, {
            id: passportVersionId,
            passportId,
            versionNo: 1,
            parentVersionId: null,
            origin: 'applicant_revision',
            workflowState: 'needs_applicant_confirmation',
            schemaVersion: passportRow.schema_version || 'hackathon-mvp-2026-08-27',
            answerVersionId,
            programRuleVersionId: program.rule_id,
            payload: serializedPassport,
            contentSha256: createHash('sha256').update(serializedPassport, 'utf8').digest('hex'),
            createdByType: 'applicant',
            createdById: input.applicantId,
            createdAt,
          });
          options.database.prepare('UPDATE cases SET current_answer_version_id = ?, current_passport_version_id = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(answerVersionId, passportVersionId, createdAt, caseId);
          reused = true;
        }

        appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: 'applicant', actorId: input.applicantId, action: 'create', entityType: 'case', entityId: caseId, beforeHash: null, afterHash: null, detail: { kind: 'operation', operation: 'create', outcome: 'ok' }, requestId: input.requestId ?? requestId(), createdAt });
        const record = getCaseForApplicant(options.database, { applicantId: input.applicantId }, caseId);
        if (!record) throw new Error('Created case could not be read');
        output = { case: record, reused };
        const body = JSON.stringify(output);
        if (!finalizeApplicantMutation({ database: options.database, crypto: options.crypto, reservation, idempotencyKey: input.idempotencyKey, status: 201, publicBody: body, now })) throw new Error('Idempotency response finalization failed');
      })(); } catch (error) { if (reservation.kind === 'reserved') deleteApplicantMutationReservation({ database: options.database, crypto: options.crypto, reservation, idempotencyKey: input.idempotencyKey }); throw error; }
      return output;
    },

    saveAnswers(input) {
      let answers: CoreAnswers;
      try { answers = validateDraftCoreAnswers(input.answers); } catch { throw new CaseCommandError('INVALID_REQUEST'); }
      if (parseQuotedEtag(input.ifMatch) === null) throw new CaseCommandError('ETAG_MISMATCH');
      const now = clock();
      const reservation = reserve(input.applicantId, 'PUT', `/api/v1/cases/${input.caseId}/answers`, input.idempotencyKey, { caseId: input.caseId, answers, ifMatch: input.ifMatch }, now);
      if (reservation.kind === 'replay') return replayData<{ case: PublicCase; answerVersion: { id: string; versionNo: number; createdAt: string } }>(reservation.body, 'case');
      const createdAt = now.toISOString();
      const hash = hashAnswers(answers);
      let output!: { case: PublicCase; answerVersion: { id: string; versionNo: number; createdAt: string } };
      try { options.database.transaction(() => {
        const row = options.database.prepare('SELECT * FROM cases WHERE id = ? AND applicant_id = ?').get(input.caseId, input.applicantId) as { id: string; state: string; row_version: number; current_answer_version_id: string | null } | undefined;
        if (!row) throw new CaseCommandError('NOT_FOUND');
        if (row.row_version !== parseQuotedEtag(input.ifMatch)) throw new CaseCommandError('ETAG_MISMATCH');
        if (row.state !== 'draft') throw new CaseCommandError('INVALID_STATE');
        const matching = options.database.prepare('SELECT id, version_no, created_at FROM answer_versions WHERE case_id = ? AND content_sha256 = ?').get(input.caseId, hash) as { id: string; version_no: number; created_at: string } | undefined;
        if (matching && matching.id !== row.current_answer_version_id) throw new CaseCommandError('INVALID_REQUEST', 'Answer matches a historical version');
        const existing = matching;
        const version = existing ?? { id: idGenerator(), version_no: latestVersion(options.database, input.caseId) + 1, created_at: createdAt };
        if (!existing) options.database.prepare('INSERT INTO answer_versions (id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(version.id, input.caseId, version.version_no, encryptDatabaseText(options.crypto, 'answer_versions', 'answers_enc', version.id, serializeCoreAnswers(answers)), hash, input.applicantId, createdAt);
        const nextRowVersion = existing ? row.row_version : row.row_version + 1;
        if (!existing) {
          options.database.prepare('UPDATE cases SET current_answer_version_id = ?, updated_at = ?, row_version = ? WHERE id = ? AND applicant_id = ? AND row_version = ?').run(version.id, createdAt, nextRowVersion, input.caseId, input.applicantId, row.row_version);
          options.database.prepare('INSERT INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)').run(idGenerator(), input.caseId, nextSequence(options.database, input.caseId), 'answers.saved', '申請答案已儲存', '{}', 'applicant', createdAt);
          appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: 'applicant', actorId: input.applicantId, action: 'update', entityType: 'case', entityId: input.caseId, beforeHash: null, afterHash: null, detail: { kind: 'field-change', field: 'answer', fieldCount: 4, outcome: 'ok' }, requestId: input.requestId ?? requestId(), createdAt });
        }
        const record = getCaseForApplicant(options.database, { applicantId: input.applicantId }, input.caseId);
        if (!record) throw new Error('Updated case could not be read');
        output = { case: record, answerVersion: { id: version.id, versionNo: version.version_no, createdAt: version.created_at } };
        if (!finalizeApplicantMutation({ database: options.database, crypto: options.crypto, reservation, idempotencyKey: input.idempotencyKey, status: 201, publicBody: JSON.stringify(output), now })) throw new Error('Idempotency response finalization failed');
      })(); } catch (error) { if (reservation.kind === 'reserved') deleteApplicantMutationReservation({ database: options.database, crypto: options.crypto, reservation, idempotencyKey: input.idempotencyKey }); throw error; }
      return output;
    },
  };
}
