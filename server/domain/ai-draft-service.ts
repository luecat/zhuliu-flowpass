import { createHash } from 'node:crypto';
import { JobRepository, type DurableJob } from '../db/repositories/jobs';
import { decryptDatabaseText } from '../db/repositories/encrypted-fields';
import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { AiDraftAdmissionGuard } from './line-session-service';
import { validateCoreAnswers, type CoreAnswers } from '../../shared/case-contract';
import { MAX_PASSPORT_JSON_BYTES } from '../../shared/passport-contract';
import { decryptDatabaseText as decryptText } from '../db/repositories/encrypted-fields';

export const AI_PROMPT_VERSION = 'flowpass-ai-v1';
export const AI_SCHEMA_VERSION = 'hackathon-mvp-2026-08-27';
export const AI_CONTEXT_LIMIT = 16_384;
export const AI_OUTPUT_RESERVATION = 4_096;
export const AI_SAFETY_RESERVATION = 1_024;
export const AI_INPUT_TOKEN_BUDGET = AI_CONTEXT_LIMIT - AI_OUTPUT_RESERVATION - AI_SAFETY_RESERVATION;

export const FIXED_AI_INSTRUCTION = 'You generate only a draft FlowPass passport. Return strict JSON matching the supplied schema. Never decide subsidy eligibility, amount, approval, rejection, or notification. Keep source excerpts redacted.';

export type AiInputProjection = {
  answers: CoreAnswers;
  currentPassport: { nodes: unknown[]; edges: unknown[]; tools: unknown[]; risk: unknown[] } | null;
  currentQuestionIds: string[];
  newAnswers: Record<string, string>;
};

export class AiDraftCommandError extends Error {
  public constructor(public readonly code: 'NOT_FOUND' | 'INVALID_STATE' | 'ETAG_MISMATCH' | 'AI_INPUT_TOO_LARGE' | 'RATE_LIMITED' | 'ACTIVE_JOB', message: string = code) {
    super(message);
    this.name = 'AiDraftCommandError';
  }
}

/** Conservative preflight estimate; production may inject a model tokenizer. */
export function estimateInputTokens(value: string): number {
  // Two tokens per Unicode scalar is intentionally an upper bound for the
  // short, user-authored envelope. A model-specific tokenizer can be injected
  // in production when a tighter bound is desirable, but admission must never
  // under-count CJK or emoji input by dividing UTF-8 bytes.
  return Math.ceil(Array.from(value).length * 2);
}
function hashInput(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
function parseAnswers(crypto: FieldCrypto, row: { id: string; answers_enc: string }): CoreAnswers {
  let value: unknown;
  try { value = JSON.parse(decryptDatabaseText(crypto, 'answer_versions', 'answers_enc', row.id, row.answers_enc)); return validateCoreAnswers(value); } catch { throw new AiDraftCommandError('INVALID_STATE', 'Answers are unavailable'); }
}

export interface AiDraftServiceOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  modelId: string;
  clock?: () => Date;
  idGenerator?: () => string;
  admission?: AiDraftAdmissionGuard;
  tokenCounter?: (value: string) => number;
}

export interface AiDraftService {
  enqueue(input: { applicantId: string; caseId: string; operation?: 'draft' | 'revise'; expectedRowVersion?: number; retryNonce?: string }): { job: DurableJob; inputHash: string; inputTokens: number };
  /** Enqueue from an already-open SQLite transaction (used by follow-up commands). */
  enqueueInTransaction(input: { applicantId: string; caseId: string; operation: 'revise' }): { job: DurableJob; inputHash: string; inputTokens: number };
  projectionForCase(input: { applicantId: string; caseId: string }): { projection: AiInputProjection; answerVersionId: string; passportVersionId: string | null };
}

export function readAiInputProjection(database: FlowPassDatabase, crypto: FieldCrypto, applicantId: string, caseId: string): { projection: AiInputProjection; answerVersionId: string; passportVersionId: string | null; programRuleVersionId: string; inputTokens?: number } {
  const row = database.prepare(`SELECT c.current_answer_version_id, c.current_passport_version_id, c.program_rule_version_id, c.state, a.id, a.answers_enc, pv.payload_enc FROM cases c LEFT JOIN answer_versions a ON a.id = c.current_answer_version_id LEFT JOIN passport_versions pv ON pv.id = c.current_passport_version_id WHERE c.id = ? AND c.applicant_id = ?`).get(caseId, applicantId) as { current_answer_version_id: string | null; current_passport_version_id: string | null; program_rule_version_id: string; state: string; id: string | null; answers_enc: string | null; payload_enc: string | null } | undefined;
  if (!row) throw new AiDraftCommandError('NOT_FOUND');
  if (row.state !== 'draft') throw new AiDraftCommandError('INVALID_STATE');
  if (!row.id || !row.answers_enc || !row.current_answer_version_id) throw new AiDraftCommandError('INVALID_STATE', 'Answers are required before an AI draft');
  const answers = parseAnswers(crypto, { id: row.id, answers_enc: row.answers_enc });
  let currentPassport: AiInputProjection['currentPassport'] = null;
  if (row.current_passport_version_id && row.payload_enc) {
    try {
      const parsed = JSON.parse(decryptText(crypto, 'passport_versions', 'payload_enc', row.current_passport_version_id, row.payload_enc)) as { passport_draft?: Record<string, unknown> } & Record<string, unknown>;
      const draft = parsed.passport_draft ?? parsed;
      if (draft && Array.isArray(draft.nodes) && Array.isArray(draft.edges)) {
        const nodes = draft.nodes as unknown[];
        currentPassport = {
          nodes,
          edges: draft.edges as unknown[],
          tools: nodes.filter((node) => Boolean(node && typeof node === 'object' && ['ai_tool', 'plugin'].includes((node as Record<string, unknown>).kind as string))),
          risk: Array.isArray(draft.safety_actions) ? draft.safety_actions as unknown[] : [],
        };
      }
    } catch { currentPassport = null; }
  }
  const currentQuestionIds: string[] = [];
  const newAnswers: Record<string, string> = {};
  if (row.current_passport_version_id) {
    const questions = database.prepare(
      `SELECT id, question_key
       FROM passport_follow_up_questions
       WHERE passport_version_id = ? AND status IN ('open', 'answered')
       ORDER BY question_key ASC`,
    ).all(row.current_passport_version_id) as Array<{ id: string; question_key: string }>;
    questions.forEach((question) => currentQuestionIds.push(question.question_key));
    const answerRows = database.prepare(
      `SELECT q.question_key, a.id, a.answer_enc
       FROM passport_follow_up_answers a
       JOIN passport_follow_up_questions q ON q.id = a.question_id
       WHERE a.passport_version_id = ? AND q.passport_version_id = ?`,
    ).all(row.current_passport_version_id, row.current_passport_version_id) as Array<{ question_key: string; id: string; answer_enc: string }>;
    answerRows.forEach((answer) => {
      try {
        const value = decryptText(crypto, 'passport_follow_up_answers', 'answer_enc', answer.id, answer.answer_enc);
        if (value.length <= 4 * 1024) newAnswers[answer.question_key] = value;
      } catch {
        // A corrupt historical follow-up is omitted from the model projection;
        // the worker will still require a fresh applicant answer.
      }
    });
  }
  return { projection: { answers, currentPassport, currentQuestionIds, newAnswers }, answerVersionId: row.current_answer_version_id, passportVersionId: row.current_passport_version_id, programRuleVersionId: row.program_rule_version_id };
}

export function createAiDraftService(options: AiDraftServiceOptions): AiDraftService {
  const clock = options.clock ?? (() => new Date());
  const admission = options.admission ?? new AiDraftAdmissionGuard(options.database, options.crypto, clock);
  const jobs = new JobRepository(options.database);
  const tokenCounter = options.tokenCounter ?? estimateInputTokens;
  const projectionForCase = (input: { applicantId: string; caseId: string }) => {
      const prepared = readAiInputProjection(options.database, options.crypto, input.applicantId, input.caseId);
      const projection = prepared.projection;
      const encoded = JSON.stringify({ system: FIXED_AI_INSTRUCTION, user: projection });
      const inputTokens = tokenCounter(encoded);
      if (inputTokens > AI_INPUT_TOKEN_BUDGET || new TextEncoder().encode(encoded).byteLength > MAX_PASSPORT_JSON_BYTES) throw new AiDraftCommandError('AI_INPUT_TOO_LARGE');
      return { projection, answerVersionId: prepared.answerVersionId, passportVersionId: prepared.passportVersionId, programRuleVersionId: prepared.programRuleVersionId, inputTokens };
  };
  function enqueueInTransaction(input: { applicantId: string; caseId: string; operation: 'draft' | 'revise'; expectedRowVersion?: number; retryNonce?: string }): { job: DurableJob; inputHash: string; inputTokens: number } {
    if (input.expectedRowVersion !== undefined) {
      const current = options.database.prepare('SELECT row_version FROM cases WHERE id = ? AND applicant_id = ?').get(input.caseId, input.applicantId) as { row_version: number } | undefined;
      if (!current || current.row_version !== input.expectedRowVersion) throw new AiDraftCommandError('ETAG_MISMATCH');
    }
    const prepared = projectionForCase(input);
    const inputHash = hashInput(prepared.projection);
    const retrySuffix = input.retryNonce ? `:retry:${input.retryNonce}` : '';
    const uniqueKey = `ai-draft:${input.caseId}:${prepared.answerVersionId}:${prepared.passportVersionId ?? 'none'}:${input.operation}${retrySuffix}`;
    const admitted = admission.admit({ applicantId: input.applicantId, caseId: input.caseId });
    if (!admitted.allowed) throw new AiDraftCommandError(admitted.retryAfter === 10 ? 'ACTIVE_JOB' : 'RATE_LIMITED');
    const job = jobs.enqueue({ systemId: 'public-ai-admission' }, {
      jobType: 'ai_draft',
      uniqueKey,
      payload: { caseId: input.caseId, answerVersionId: prepared.answerVersionId, passportVersionId: prepared.passportVersionId, programRuleVersionId: prepared.programRuleVersionId, operation: input.operation, modelId: options.modelId, inputHash, inputTokens: prepared.inputTokens, promptVersion: AI_PROMPT_VERSION, schemaVersion: AI_SCHEMA_VERSION },
      createdAt: clock().toISOString(),
    });
    return { job, inputHash, inputTokens: prepared.inputTokens };
  }
  return {
    projectionForCase,
    enqueue(input) {
      return options.database.transaction(() => enqueueInTransaction({ ...input, operation: input.operation ?? 'draft' }))();
    },
    enqueueInTransaction(input) {
      return enqueueInTransaction(input);
    },
  };
}
