import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../db/connection';
import type { FieldCrypto } from '../crypto/field-crypto';
import { decryptDatabaseText } from '../db/repositories/encrypted-fields';
import { insertEncryptedPassportFollowUpAnswerForSystem, insertEncryptedPassportFollowUpQuestionForSystem, insertEncryptedPassportVersionForSystem } from '../db/repositories/passports';
import { appendEncryptedAuditLog } from '../db/repositories/audit';
import { inspectPassportDocument } from './passport-validation';
import type { FlowPassPassport, FollowUpQuestion } from '../../shared/passport-contract';
import { parseQuotedEtag } from '../../shared/api-contract';

export type PassportWorkflowState =
  | 'ai_drafting'
  | 'follow_up_required'
  | 'needs_applicant_confirmation'
  | 'confirmed'
  | 'locked';

export class PassportLifecycleError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'ETAG_MISMATCH' | 'INVALID_STATE' | 'INVALID_REQUEST' | 'PASSPORT_NOT_READY' | 'STALE_VERSION', message = code) {
    super(message);
    this.name = 'PassportLifecycleError';
  }
}

type IdGenerator = () => string;
type Origin = 'ai_draft' | 'applicant_revision' | 'admin_supplement';

export interface PassportVersionSummary {
  id: string;
  passportId: string;
  versionNo: number;
  parentVersionId: string | null;
  origin: Origin;
  workflowState: PassportWorkflowState;
  schemaVersion: string;
  answerVersionId: string;
  programRuleVersionId: string;
  createdAt: string;
}

export interface PassportFollowUp {
  id: string;
  questionKey: string;
  passportVersionId: string;
  versionNo: number;
  prompt: string;
  reason: string;
  answerSchema: unknown;
  required: boolean;
  relatedNodeIds: string[];
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'answered' | 'superseded';
  answer?: string;
}

export interface PassportForApplicant {
  version: PassportVersionSummary;
  passport: FlowPassPassport;
  followUps: PassportFollowUp[];
  etag: string;
}

export interface CreatePassportVersionInput {
  caseId: string;
  answerVersionId: string;
  passport: FlowPassPassport;
  origin: Origin;
  actorType: string;
  actorId: string;
  parentVersionId?: string | null;
  workflowState?: PassportWorkflowState;
  contentSha256?: string;
  /** Hook invoked inside the version-creation transaction after the version and
   * indexes exist. Used by workers to atomically append related metadata. */
  onVersionCreated?: (version: PassportVersionSummary) => void;
}

export interface FollowUpAnswerInput {
  questionId: string;
  answer: string;
}

export interface PassportDeclaration {
  confirmationType: string;
  targetKey: string;
  value: unknown;
}

export interface PassportLifecycleOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  clock?: () => Date;
  idGenerator?: IdGenerator;
  /** Optional command hook. It is invoked while the follow-up mutation transaction is open. */
  enqueueRevision?: (input: { applicantId: string; caseId: string; passportVersionId: string }) => { jobId: string; state: string };
}

export interface FollowUpMutationResult extends PassportVersionSummary {
  revisionJobId?: string;
  revisionJobState?: string;
}

export interface PassportLifecycle {
  createVersion(input: CreatePassportVersionInput): { version: PassportVersionSummary; followUps: PassportFollowUp[] };
  getForApplicant(input: { applicantId: string; caseId: string; versionId?: string }): PassportForApplicant | null;
  answerFollowUps(input: { applicantId: string; caseId: string; passportVersionId: string; ifMatch: string; answers: FollowUpAnswerInput[]; declarations: PassportDeclaration[] }): FollowUpMutationResult;
  confirmVersion(input: { applicantId: string; caseId: string; passportVersionId: string; ifMatch: string; declarations?: PassportDeclaration[] }): PassportVersionSummary;
}

interface VersionRow {
  id: string;
  passport_id: string;
  version_no: number;
  parent_version_id: string | null;
  origin: Origin;
  workflow_state: PassportWorkflowState;
  schema_version: string;
  answer_version_id: string;
  program_rule_version_id: string;
  payload_enc: string;
  content_sha256: string;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
}

interface FollowUpRow {
  id: string;
  passport_version_id: string;
  question_key: string;
  version_no: number;
  prompt_enc: string;
  reason_enc: string;
  answer_schema_json: string;
  required: number;
  related_node_keys_json: string;
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'answered' | 'superseded';
}

function transactionally<T>(database: FlowPassDatabase, callback: () => T): T {
  return database.transaction(callback)();
}

function versionSummary(row: VersionRow): PassportVersionSummary {
  return {
    id: row.id,
    passportId: row.passport_id,
    versionNo: row.version_no,
    parentVersionId: row.parent_version_id,
    origin: row.origin,
    workflowState: row.workflow_state,
    schemaVersion: row.schema_version,
    answerVersionId: row.answer_version_id,
    programRuleVersionId: row.program_rule_version_id,
    createdAt: row.created_at,
  };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new PassportLifecycleError('INVALID_REQUEST'); }
}

function passportHash(passport: FlowPassPassport, state: PassportWorkflowState, versionNo: number): string {
  return createHash('sha256').update(JSON.stringify(passport)).update(`\n${state}\n${versionNo}`).digest('hex');
}

function questionFromCanonical(question: FollowUpQuestion): Omit<PassportFollowUp, 'id' | 'passportVersionId' | 'versionNo' | 'status' | 'answer'> {
  return {
    questionKey: question.id,
    prompt: question.prompt,
    reason: question.reason,
    answerSchema: question.answerSchema,
    required: question.required,
    relatedNodeIds: question.relatedNodeIds,
    priority: question.priority,
  };
}

function mapFollowUp(row: FollowUpRow, crypto: FieldCrypto, answer?: string): PassportFollowUp {
  let relatedNodeIds: string[] = [];
  try {
    const parsed = JSON.parse(row.related_node_keys_json);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) relatedNodeIds = parsed;
  } catch { /* the database JSON check prevents this; fail closed in the projection */ }
  return {
    id: row.id,
    passportVersionId: row.passport_version_id,
    questionKey: row.question_key,
    versionNo: row.version_no,
    prompt: decryptDatabaseText(crypto, 'passport_follow_up_questions', 'prompt_enc', row.id, row.prompt_enc),
    reason: decryptDatabaseText(crypto, 'passport_follow_up_questions', 'reason_enc', row.id, row.reason_enc),
    answerSchema: parseJson(row.answer_schema_json),
    required: row.required === 1,
    relatedNodeIds,
    priority: row.priority,
    status: row.status,
    ...(answer === undefined ? {} : { answer }),
  };
}

function getVersion(database: FlowPassDatabase, caseId: string, versionId?: string): VersionRow | null {
  const row = database.prepare(`
    SELECT passport_versions.*
    FROM passport_versions
    JOIN passports ON passports.id = passport_versions.passport_id
    WHERE passports.case_id = ? AND (? IS NULL OR passport_versions.id = ?)
    ORDER BY passport_versions.version_no DESC LIMIT 1
  `).get(caseId, versionId ?? null, versionId ?? null) as VersionRow | undefined;
  return row ?? null;
}

function currentVersion(database: FlowPassDatabase, caseId: string): VersionRow | null {
  const row = database.prepare(`
    SELECT passport_versions.*
    FROM cases
    JOIN passport_versions ON passport_versions.id = cases.current_passport_version_id
    WHERE cases.id = ?
  `).get(caseId) as VersionRow | undefined;
  return row ?? null;
}

function validateIfMatch(ifMatch: string, versionNo: number): void {
  if (parseQuotedEtag(ifMatch) !== versionNo) throw new PassportLifecycleError('ETAG_MISMATCH');
}

function validAnswer(answerSchema: unknown, answer: string): boolean {
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 4_096) return false;
  if (!answerSchema || typeof answerSchema !== 'object' || Array.isArray(answerSchema)) return false;
  const schema = answerSchema as { type?: unknown; choices?: unknown; maxLength?: unknown };
  if (schema.type === 'text') return typeof schema.maxLength === 'number' && Array.from(answer).length <= schema.maxLength;
  if (schema.type === 'single_choice') return Array.isArray(schema.choices) && schema.choices.includes(answer);
  if (schema.type === 'multi_choice') {
    const choices = Array.isArray(schema.choices) && schema.choices.every((choice): choice is string => typeof choice === 'string') ? schema.choices : null;
    if (!choices || choices.length === 0) return false;
    try {
      const selected = JSON.parse(answer) as unknown;
      return Array.isArray(selected) && selected.length > 0 && selected.every((value) => typeof value === 'string' && choices.includes(value));
    } catch {
      return false;
    }
  }
  if (schema.type === 'boolean') return answer === 'true' || answer === 'false';
  if (schema.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(answer);
  return false;
}

function safeDeclaration(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return text !== undefined && new TextEncoder().encode(text).byteLength <= 4_096;
  } catch { return false; }
}

function requiredRemaining(database: FlowPassDatabase, versionId: string): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM passport_follow_up_questions q
    LEFT JOIN passport_follow_up_answers a ON a.question_id = q.id
    WHERE q.passport_version_id = ? AND q.required = 1 AND q.status = 'open' AND a.id IS NULL
  `).get(versionId) as { count: number };
  return row.count;
}

export function createPassportLifecycle(options: PassportLifecycleOptions): PassportLifecycle {
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? uuidv7;
  const systemScope = { systemId: 'passport-lifecycle' } as const;

  function loadQuestions(versionId: string): PassportFollowUp[] {
    const rows = options.database.prepare('SELECT * FROM passport_follow_up_questions WHERE passport_version_id = ? ORDER BY priority, id').all(versionId) as FollowUpRow[];
    return rows.map((row) => {
      const answer = options.database.prepare('SELECT id, answer_enc FROM passport_follow_up_answers WHERE question_id = ?').get(row.id) as { id: string; answer_enc: string } | undefined;
      return mapFollowUp(row, options.crypto, answer ? decryptDatabaseText(options.crypto, 'passport_follow_up_answers', 'answer_enc', answer.id, answer.answer_enc) : undefined);
    });
  }

  function insertQuestions(version: PassportVersionSummary, passport: FlowPassPassport): PassportFollowUp[] {
    const createdAt = version.createdAt;
    return passport.follow_up_questions.map((question) => {
      const id = idGenerator();
      const input = questionFromCanonical(question);
      insertEncryptedPassportFollowUpQuestionForSystem(options.database, systemScope, options.crypto, {
        id,
        passportVersionId: version.id,
        questionKey: input.questionKey,
        versionNo: version.versionNo,
        prompt: input.prompt,
        reason: input.reason,
        answerSchemaJson: JSON.stringify(input.answerSchema),
        required: input.required,
        relatedNodeKeysJson: JSON.stringify(input.relatedNodeIds),
        priority: input.priority,
        status: 'open',
        createdAt,
      });
      return mapFollowUp(options.database.prepare('SELECT * FROM passport_follow_up_questions WHERE id = ?').get(id) as FollowUpRow, options.crypto);
    });
  }

  function updateCurrentCase(caseId: string, passportVersionId: string, updatedAt: string): void {
    options.database.prepare(`UPDATE cases SET current_passport_version_id = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?`).run(passportVersionId, updatedAt, caseId);
  }

  function createVersionInternal(input: CreatePassportVersionInput, state: PassportWorkflowState, afterCreated?: (version: PassportVersionSummary) => void): { version: PassportVersionSummary; followUps: PassportFollowUp[] } {
    const inspection = inspectPassportDocument({ passport_draft: input.passport });
    if (!inspection.canonical || inspection.validation.ok === false) throw new PassportLifecycleError('PASSPORT_NOT_READY');
    const passport = inspection.canonical;
    const now = clock().toISOString();
    return transactionally(options.database, () => {
      const caseRow = options.database.prepare(`SELECT id, program_rule_version_id, current_answer_version_id, current_passport_version_id, applicant_id FROM cases WHERE id = ?`).get(input.caseId) as { id: string; program_rule_version_id: string; current_answer_version_id: string | null; current_passport_version_id: string | null; applicant_id: string } | undefined;
      if (!caseRow || caseRow.current_answer_version_id !== input.answerVersionId) throw new PassportLifecycleError('STALE_VERSION');
      if (input.parentVersionId && input.parentVersionId !== caseRow.current_passport_version_id) throw new PassportLifecycleError('STALE_VERSION');
      if (caseRow.current_passport_version_id && !input.parentVersionId) throw new PassportLifecycleError('STALE_VERSION');
      const parent = input.parentVersionId ? getVersion(options.database, input.caseId, input.parentVersionId) : null;
      if (input.parentVersionId && !parent) throw new PassportLifecycleError('STALE_VERSION');
      const passportRow = options.database.prepare('SELECT id FROM passports WHERE case_id = ?').get(input.caseId) as { id: string } | undefined;
      const passportId = passportRow?.id ?? idGenerator();
      if (!passportRow) options.database.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(passportId, input.caseId, now);
      const versionNo = ((options.database.prepare('SELECT COALESCE(MAX(version_no), 0) AS max FROM passport_versions WHERE passport_id = ?').get(passportId) as { max: number }).max) + 1;
      const id = idGenerator();
      const version: PassportVersionSummary = { id, passportId, versionNo, parentVersionId: input.parentVersionId ?? null, origin: input.origin, workflowState: state, schemaVersion: 'flowpass.passport.v1', answerVersionId: input.answerVersionId, programRuleVersionId: caseRow.program_rule_version_id, createdAt: now };
      insertEncryptedPassportVersionForSystem(options.database, systemScope, options.crypto, { id, passportId, versionNo, parentVersionId: version.parentVersionId, origin: input.origin, workflowState: state, schemaVersion: version.schemaVersion, answerVersionId: input.answerVersionId, programRuleVersionId: caseRow.program_rule_version_id, payload: JSON.stringify(passport), contentSha256: input.contentSha256 ?? passportHash(passport, state, versionNo), createdByType: input.actorType, createdById: input.actorId, createdAt: now });
      const followUps = insertQuestions(version, passport);
      passport.nodes.forEach((node) => options.database.prepare(`INSERT INTO passport_node_index (id, passport_version_id, node_key, kind, data_category, sensitivity, needs_confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), id, node.id, node.kind, node.data_category, node.sensitivity, node.needs_confirmation ? 1 : 0));
      passport.edges.forEach((edge) => options.database.prepare(`INSERT INTO passport_edge_index (id, passport_version_id, edge_key, from_node_key, to_node_key, purpose_code, needs_confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), id, edge.id, edge.from_node_id, edge.to_node_id, edge.purpose, edge.needs_confirmation ? 1 : 0));
      const sequence = ((options.database.prepare('SELECT COALESCE(MAX(sequence_no), 0) AS max FROM timeline_events WHERE case_id = ?').get(input.caseId) as { max: number }).max) + 1;
      options.database.prepare(`INSERT INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), input.caseId, sequence, id, 'passport_version_created', '護照草稿已建立', JSON.stringify({ versionNo, workflowState: state }), input.actorType, now);
      appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: input.actorType, actorId: input.actorId, action: 'create', entityType: 'passport', entityId: id, beforeHash: null, afterHash: input.contentSha256 ?? null, detail: { kind: 'operation', operation: 'create', outcome: 'ok' }, requestId: idGenerator(), createdAt: now });
      updateCurrentCase(input.caseId, id, now);
      input.onVersionCreated?.(version);
      afterCreated?.(version);
      return { version, followUps };
    });
  }

  function cloneVersion(input: { caseId: string; source: VersionRow; passport: FlowPassPassport; state: PassportWorkflowState; applicantId: string; declarations: PassportDeclaration[] }): PassportVersionSummary {
    for (const declaration of input.declarations) {
      if (!safeDeclaration(declaration.value) || !declaration.confirmationType.trim() || !declaration.targetKey.trim()) throw new PassportLifecycleError('INVALID_REQUEST');
    }
    const result = createVersionInternal({ caseId: input.caseId, answerVersionId: input.source.answer_version_id, passport: input.passport, origin: 'applicant_revision', actorType: 'applicant', actorId: input.applicantId, parentVersionId: input.source.id }, input.state, (version) => {
      const sourceDeclarations = options.database.prepare('SELECT confirmation_type, target_key, value_json, applicant_id, confirmed_at FROM passport_confirmations WHERE passport_version_id = ?').all(input.source.id) as Array<{ confirmation_type: string; target_key: string; value_json: string; applicant_id: string; confirmed_at: string }>;
      for (const declaration of sourceDeclarations) {
        options.database.prepare(`INSERT INTO passport_confirmations (id, passport_version_id, confirmation_type, target_key, value_json, applicant_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), version.id, declaration.confirmation_type, declaration.target_key, declaration.value_json, declaration.applicant_id, declaration.confirmed_at);
      }
      for (const declaration of input.declarations) {
        options.database.prepare(`INSERT INTO passport_confirmations (id, passport_version_id, confirmation_type, target_key, value_json, applicant_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), version.id, declaration.confirmationType, declaration.targetKey, JSON.stringify(declaration.value), input.applicantId, clock().toISOString());
      }
      if (input.declarations.length > 0) {
        appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: 'applicant', actorId: input.applicantId, action: 'update', entityType: 'passport', entityId: version.id, beforeHash: null, afterHash: null, detail: { kind: 'field-change', field: 'passport', fieldCount: input.declarations.length, outcome: 'ok' }, requestId: idGenerator(), createdAt: clock().toISOString() });
      }
      const oldQuestions = options.database.prepare('SELECT * FROM passport_follow_up_questions WHERE passport_version_id = ?').all(input.source.id) as FollowUpRow[];
      const newQuestions = options.database.prepare('SELECT * FROM passport_follow_up_questions WHERE passport_version_id = ?').all(version.id) as FollowUpRow[];
      for (const oldQuestion of oldQuestions) {
        const answer = options.database.prepare('SELECT id, answer_enc FROM passport_follow_up_answers WHERE question_id = ?').get(oldQuestion.id) as { id: string; answer_enc: string } | undefined;
        const newQuestion = newQuestions.find((candidate) => candidate.question_key === oldQuestion.question_key);
        if (!answer || !newQuestion) continue;
        const text = decryptDatabaseText(options.crypto, 'passport_follow_up_answers', 'answer_enc', answer.id, answer.answer_enc);
        insertEncryptedPassportFollowUpAnswerForSystem(options.database, systemScope, options.crypto, { id: idGenerator(), questionId: newQuestion.id, passportVersionId: version.id, answer: text, answeredByApplicantId: input.applicantId, answeredAt: clock().toISOString() });
        options.database.prepare("UPDATE passport_follow_up_questions SET status = 'answered' WHERE id = ?").run(newQuestion.id);
      }
    });
    return result.version;
  }

  return {
    createVersion(input) {
      const state = input.workflowState ?? (input.passport.follow_up_questions.some((question) => question.required) ? 'follow_up_required' : 'needs_applicant_confirmation');
      return createVersionInternal(input, state);
    },

    getForApplicant(input) {
      const caseRow = options.database.prepare('SELECT current_passport_version_id, applicant_id FROM cases WHERE id = ? AND applicant_id = ?').get(input.caseId, input.applicantId) as { current_passport_version_id: string | null; applicant_id: string } | undefined;
      if (!caseRow?.current_passport_version_id) return null;
      const row = getVersion(options.database, input.caseId, input.versionId ?? caseRow.current_passport_version_id);
      if (!row) return null;
      const payload = parseJson(decryptDatabaseText(options.crypto, 'passport_versions', 'payload_enc', row.id, row.payload_enc));
      const inspection = inspectPassportDocument({ passport_draft: payload });
      if (!inspection.canonical) return null;
      return { version: versionSummary(row), passport: inspection.canonical, followUps: loadQuestions(row.id), etag: `"${row.version_no}"` };
    },

    answerFollowUps(input) {
      const pending = transactionally(options.database, () => {
        // Re-read the current pointer and version while the write transaction
        // is open. A worker may have installed a newer immutable version after
        // the request was parsed; that stale request must not append answers.
        const source = currentVersion(options.database, input.caseId);
        const owner = options.database.prepare('SELECT applicant_id FROM cases WHERE id = ?').get(input.caseId) as { applicant_id: string } | undefined;
        if (!source || !owner || owner.applicant_id !== input.applicantId) throw new PassportLifecycleError('NOT_FOUND');
        if (source.id !== input.passportVersionId) throw new PassportLifecycleError('STALE_VERSION');
        validateIfMatch(input.ifMatch, source.version_no);
        if (source.workflow_state !== 'follow_up_required') throw new PassportLifecycleError('INVALID_STATE');
        const now = clock().toISOString();
        for (const answer of input.answers) {
          const question = options.database.prepare('SELECT * FROM passport_follow_up_questions WHERE id = ? AND passport_version_id = ?').get(answer.questionId, source.id) as FollowUpRow | undefined;
          if (!question || question.status !== 'open') throw new PassportLifecycleError('STALE_VERSION');
          if (question.required !== 1) throw new PassportLifecycleError('INVALID_REQUEST');
          if (!validAnswer(parseJson(question.answer_schema_json), answer.answer)) throw new PassportLifecycleError('INVALID_REQUEST');
          const existing = options.database.prepare('SELECT id FROM passport_follow_up_answers WHERE question_id = ?').get(question.id);
          if (existing) throw new PassportLifecycleError('INVALID_STATE');
          insertEncryptedPassportFollowUpAnswerForSystem(options.database, systemScope, options.crypto, { id: idGenerator(), questionId: question.id, passportVersionId: source.id, answer: answer.answer, answeredByApplicantId: input.applicantId, answeredAt: now });
          options.database.prepare("UPDATE passport_follow_up_questions SET status = 'answered' WHERE id = ?").run(question.id);
        }
        for (const declaration of input.declarations) {
          if (!safeDeclaration(declaration.value) || !declaration.confirmationType.trim() || !declaration.targetKey.trim()) throw new PassportLifecycleError('INVALID_REQUEST');
          options.database.prepare(`INSERT INTO passport_confirmations (id, passport_version_id, confirmation_type, target_key, value_json, applicant_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), source.id, declaration.confirmationType, declaration.targetKey, JSON.stringify(declaration.value), input.applicantId, now);
        }
        if (input.answers.length > 0) {
          appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: 'applicant', actorId: input.applicantId, action: 'update', entityType: 'passport', entityId: source.id, beforeHash: null, afterHash: null, detail: { kind: 'field-change', field: 'answer', fieldCount: input.answers.length, outcome: 'ok' }, requestId: idGenerator(), createdAt: now });
        } else if (input.declarations.length > 0) {
          appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: 'applicant', actorId: input.applicantId, action: 'update', entityType: 'passport', entityId: source.id, beforeHash: null, afterHash: null, detail: { kind: 'field-change', field: 'passport', fieldCount: input.declarations.length, outcome: 'ok' }, requestId: idGenerator(), createdAt: now });
        }
        if (requiredRemaining(options.database, source.id) > 0 || input.answers.length === 0) return { summary: versionSummary(source), revision: null as { jobId: string; state: string } | null };
        const revision = options.enqueueRevision?.({ applicantId: input.applicantId, caseId: input.caseId, passportVersionId: source.id }) ?? null;
        return { summary: versionSummary(source), revision };
      });
      return { ...pending.summary, ...(pending.revision ? { revisionJobId: pending.revision.jobId, revisionJobState: pending.revision.state } : {}) };
    },

    confirmVersion(input) {
      const source = currentVersion(options.database, input.caseId);
      const owner = options.database.prepare('SELECT applicant_id FROM cases WHERE id = ?').get(input.caseId) as { applicant_id: string } | undefined;
      if (!source || !owner || owner.applicant_id !== input.applicantId) throw new PassportLifecycleError('NOT_FOUND');
      if (source.id !== input.passportVersionId) throw new PassportLifecycleError('STALE_VERSION');
      validateIfMatch(input.ifMatch, source.version_no);
      if (source.workflow_state !== 'needs_applicant_confirmation') throw new PassportLifecycleError('INVALID_STATE');
      if (requiredRemaining(options.database, source.id) > 0) throw new PassportLifecycleError('PASSPORT_NOT_READY');
      const payload = parseJson(decryptDatabaseText(options.crypto, 'passport_versions', 'payload_enc', source.id, source.payload_enc));
      const inspection = inspectPassportDocument({ passport_draft: payload });
      if (!inspection.canonical || inspection.diagnostics.some((issue) => issue.severity === 'error')) throw new PassportLifecycleError('PASSPORT_NOT_READY');
      const declarations = input.declarations ?? [];
      if (!declarations.some((declaration) => declaration.confirmationType === 'passport' && declaration.targetKey === 'confirm' && declaration.value === true)) throw new PassportLifecycleError('INVALID_REQUEST');
      return cloneVersion({ caseId: input.caseId, source, passport: inspection.canonical, state: 'confirmed', applicantId: input.applicantId, declarations });
    },
  };
}
