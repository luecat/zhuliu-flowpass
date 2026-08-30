import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../../db/connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { inspectPassportJson } from '../../domain/passport-validation';
import { LmStudioError, type LmStudioClient } from '../../adapters/lm-studio/lm-studio-client';
import type { DurableJob, WorkerScope } from '../../db/repositories/jobs';
import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION, FIXED_AI_INSTRUCTION, readAiInputProjection, type AiInputProjection } from '../../domain/ai-draft-service';
import { createPassportLifecycle } from '../../domain/passport-lifecycle';
import { MAX_PASSPORT_JSON_BYTES } from '../../../shared/passport-contract';

export interface GeneratePassportOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  client: Pick<LmStudioClient, 'complete'>;
  clock?: () => Date;
  idGenerator?: () => string;
}

export interface GeneratePassportResult { passportVersionId: string; resultCode: 'AI_DRAFT_CREATED' | 'AI_DRAFT_REUSED'; repairCount: number; }

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function boundedInvalidStructure(raw: string): unknown {
  if (new TextEncoder().encode(raw).byteLength > MAX_PASSPORT_JSON_BYTES) return null;
  try { return JSON.parse(raw.replace(/^```json\s*\r?\n/i, '').replace(/\r?\n```\s*$/i, '').trim()); } catch { return null; }
}
function payloadOf(job: DurableJob): { caseId: string; answerVersionId: string; passportVersionId: string | null; programRuleVersionId: string; operation: 'draft' | 'revise'; modelId: string; inputHash: string; inputTokens?: number; promptVersion?: string; schemaVersion?: string } {
  const value = job.payload;
  if (!value || typeof value !== 'object') throw new Error('AI job payload is invalid');
  const p = value as Record<string, unknown>;
  if (typeof p.caseId !== 'string' || typeof p.answerVersionId !== 'string' || (p.operation !== 'draft' && p.operation !== 'revise') || typeof p.modelId !== 'string' || typeof p.inputHash !== 'string' || typeof p.programRuleVersionId !== 'string' || !(typeof p.passportVersionId === 'string' || p.passportVersionId === null)) throw new Error('AI job payload is invalid');
  return p as unknown as ReturnType<typeof payloadOf>;
}

export async function generatePassport(job: DurableJob, scope: WorkerScope, options: GeneratePassportOptions): Promise<GeneratePassportResult> {
  if (job.jobType !== 'ai_draft') throw new Error('unsupported job type');
  const payload = payloadOf(job);
  const started = Date.now();
  const source = options.database.prepare('SELECT applicant_id, current_passport_version_id, program_rule_version_id FROM cases WHERE id = ? AND current_answer_version_id = ?').get(payload.caseId, payload.answerVersionId) as { applicant_id: string; current_passport_version_id: string | null; program_rule_version_id: string } | undefined;
  if (!source) throw new Error('AI answer version is unavailable');
  if (source.current_passport_version_id !== payload.passportVersionId || source.program_rule_version_id !== payload.programRuleVersionId) throw new Error('AI job snapshot is stale');
  const projection: AiInputProjection = readAiInputProjection(options.database, options.crypto, source.applicant_id, payload.caseId).projection;
  let result;
  try {
    result = await options.client.complete({ systemInstruction: FIXED_AI_INSTRUCTION, inputEnvelope: projection });
  } catch (error) {
    if (error instanceof LmStudioError) throw error;
    throw new LmStudioError('MODEL_OFFLINE');
  }
  let inspection = inspectPassportJson(result.content);
  let repairCount = 0;
  if (!inspection.validation.ok || !inspection.canonical) {
    repairCount = 1;
    try {
      const repaired = await options.client.complete({
        systemInstruction: FIXED_AI_INSTRUCTION,
        inputEnvelope: {},
        repairIssues: inspection.validation.ok ? [] : inspection.validation.errors,
        invalidStructure: inspection.canonical ?? boundedInvalidStructure(result.content),
      });
      inspection = inspectPassportJson(repaired.content);
      result = { ...repaired, inputTokens: result.inputTokens, outputTokens: repaired.outputTokens };
    } catch (error) {
      if (error instanceof LmStudioError) throw error;
      throw new LmStudioError('AI_OUTPUT_INVALID');
    }
  }
  if (!inspection.validation.ok || !inspection.canonical) throw new LmStudioError('AI_OUTPUT_INVALID');
  const canonicalText = JSON.stringify({ passport_draft: inspection.canonical });
  // A revision is an immutable child even when the model returns the same
  // canonical content. Scope its storage hash to the captured parent so the
  // database uniqueness guard does not collapse the revision into the parent.
  const contentSha256 = hash(payload.operation === 'revise' ? `${canonicalText}\nrevision-parent:${payload.passportVersionId ?? 'none'}` : canonicalText);
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = clock().toISOString();
  repairCount += inspection.validation.repairs.length;
  let versionId = '';
  let reused = false;
  const existing = options.database.prepare('SELECT pv.id FROM passport_versions pv JOIN passports p ON p.id = pv.passport_id WHERE p.case_id = ? AND pv.content_sha256 = ?').get(payload.caseId, contentSha256) as { id: string } | undefined;
  if (existing) {
    reused = true;
    options.database.transaction(() => {
      const snapshot = options.database.prepare('SELECT current_answer_version_id, current_passport_version_id, program_rule_version_id FROM cases WHERE id = ?').get(payload.caseId) as { current_answer_version_id: string | null; current_passport_version_id: string | null; program_rule_version_id: string } | undefined;
      if (!snapshot || snapshot.current_answer_version_id !== payload.answerVersionId || snapshot.current_passport_version_id !== payload.passportVersionId || snapshot.program_rule_version_id !== payload.programRuleVersionId) throw new Error('AI job snapshot is stale');
      const current = options.database.prepare('SELECT pv.id FROM passport_versions pv JOIN passports p ON p.id = pv.passport_id WHERE p.case_id = ? AND pv.content_sha256 = ?').get(payload.caseId, contentSha256) as { id: string } | undefined;
      if (!current) throw new Error('AI output reuse target is unavailable');
      versionId = current.id;
      options.database.prepare(`INSERT INTO ai_runs (id, case_id, passport_version_id, operation, adapter, model_id, prompt_version, schema_version, input_hash, output_hash, input_tokens, output_tokens, duration_ms, result_code, repair_count, created_at) VALUES (?, ?, ?, ?, 'lm_studio', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), payload.caseId, versionId, payload.operation, payload.modelId, payload.promptVersion ?? AI_PROMPT_VERSION, payload.schemaVersion ?? AI_SCHEMA_VERSION, payload.inputHash, hash(result.content), payload.inputTokens ?? result.inputTokens, result.outputTokens, Math.max(0, Date.now() - started), 'AI_DRAFT_REUSED', repairCount, now);
    })();
  } else {
    let runInserted = false;
    const lifecycle = createPassportLifecycle({ database: options.database, crypto: options.crypto, clock, idGenerator });
    const created = lifecycle.createVersion({
      caseId: payload.caseId,
      answerVersionId: payload.answerVersionId,
      passport: inspection.canonical,
      origin: payload.operation === 'revise' ? 'applicant_revision' : 'ai_draft',
      actorType: 'system',
      actorId: scope.workerId,
      parentVersionId: payload.passportVersionId,
      contentSha256,
      onVersionCreated: (version) => {
        options.database.prepare(`INSERT INTO ai_runs (id, case_id, passport_version_id, operation, adapter, model_id, prompt_version, schema_version, input_hash, output_hash, input_tokens, output_tokens, duration_ms, result_code, repair_count, created_at) VALUES (?, ?, ?, ?, 'lm_studio', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), payload.caseId, version.id, payload.operation, payload.modelId, payload.promptVersion ?? AI_PROMPT_VERSION, payload.schemaVersion ?? AI_SCHEMA_VERSION, payload.inputHash, hash(result.content), payload.inputTokens ?? result.inputTokens, result.outputTokens, Math.max(0, Date.now() - started), 'AI_DRAFT_CREATED', repairCount, now);
        runInserted = true;
      },
    });
    if (!runInserted) throw new Error('AI run metadata was not persisted');
    versionId = created.version.id;
  }
  return { passportVersionId: versionId, resultCode: reused ? 'AI_DRAFT_REUSED' : 'AI_DRAFT_CREATED', repairCount };
}
