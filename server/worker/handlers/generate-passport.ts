import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../../db/connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { collectPassportDiagnostics, inspectPassportJson } from '../../domain/passport-validation';
import { LmStudioError, type LmStudioClient } from '../../adapters/lm-studio/lm-studio-client';
import type { DurableJob, WorkerScope } from '../../db/repositories/jobs';
import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION, FIXED_AI_INSTRUCTION, readAiInputProjection, type AiInputProjection } from '../../domain/ai-draft-service';
import { createPassportLifecycle } from '../../domain/passport-lifecycle';
import { MAX_PASSPORT_JSON_BYTES, type FlowPassPassport, type ValidationIssue } from '../../../shared/passport-contract';
import { followUpTopics, hasApplicantInternalReference, normalizedFollowUpText } from '../../../shared/follow-up-policy';

export interface GeneratePassportOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  client: Pick<LmStudioClient, 'complete'>;
  clock?: () => Date;
  idGenerator?: () => string;
}

export interface GeneratePassportResult { passportVersionId: string; resultCode: 'AI_DRAFT_CREATED' | 'AI_DRAFT_REUSED'; repairCount: number; }

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
const MAX_SCHEMA_REWRITES = 2;
const REQUIRED_INVOICE_FIELDS = ['tool_name', 'purchase_date', 'amount', 'invoice_number'] as const;
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
const ANSWER_FIELD_NAMES = new Set([
  'material', 'aiPurpose', 'sensitiveData', 'destinationAndAudience',
  'materials', 'intended_use', 'personal_or_sensitive_data', 'destination_and_audience',
]);
function normalizedEvidence(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase(); }
function supportedByApplicant(value: unknown, projection: AiInputProjection): boolean {
  if (typeof value !== 'string' || !value.trim() || value === 'unknown') return false;
  const candidate = normalizedEvidence(value);
  return [...Object.values(projection.answers), ...projection.answeredFollowUps.map((item) => item.answer)]
    .some((source) => normalizedEvidence(source).includes(candidate));
}
const UNCERTAIN_ANSWER_PATTERN = /^(?:不確定|不知道|尚未決定|未決定|待確認|還沒想好|unknown|unsure|not sure|n\/?a)[\s。，,.!！?？]*$/iu;
function answerNeedsClarification(value: string): boolean {
  return !value.trim() || UNCERTAIN_ANSWER_PATTERN.test(value.normalize('NFKC').trim());
}
function followUpIsGrounded(question: { prompt: string; reason: string }, projection: AiInputProjection): boolean {
  const topics = followUpTopics(question.prompt, question.reason);
  if (topics.length === 0) return false;
  return topics.some((topic) => {
    if (topic === 'retention' || topic === 'tool') return true;
    if (topic === 'material') return answerNeedsClarification(projection.answers.materials);
    if (topic === 'purpose') return answerNeedsClarification(projection.answers.intended_use);
    if (topic === 'sensitive_data') return answerNeedsClarification(projection.answers.personal_or_sensitive_data);
    return answerNeedsClarification(projection.answers.destination_and_audience);
  });
}
function normalizeFollowUpQuestions(draft: Record<string, unknown>, projection: AiInputProjection, finalRevision: boolean): number {
  const questionKey = Array.isArray(draft.follow_up_questions)
    ? 'follow_up_questions'
    : Array.isArray(draft.confirmation_questions)
      ? 'confirmation_questions'
      : null;
  if (!questionKey) return 0;
  const current = draft[questionKey] as unknown[];
  if (finalRevision) {
    if (current.length === 0) return 0;
    draft[questionKey] = [];
    return 1;
  }

  const seenTopics = new Set<string>();
  const seenText = new Set<string>();
  const next: unknown[] = [];
  for (const item of current) {
    const prompt = isRecord(item) && typeof item.prompt === 'string'
      ? item.prompt
      : isRecord(item) && typeof item.question === 'string'
        ? item.question
        : null;
    if (!isRecord(item) || prompt === null) {
      next.push(item);
      continue;
    }
    const reason = typeof item.reason === 'string' ? item.reason : '';
    if (!followUpIsGrounded({ prompt, reason }, projection)) continue;
    const topics = followUpTopics(prompt, reason);
    const textKey = normalizedFollowUpText(prompt);
    if ((textKey && seenText.has(textKey)) || topics.some((topic) => seenTopics.has(topic))) continue;
    if (textKey) seenText.add(textKey);
    topics.forEach((topic) => seenTopics.add(topic));
    next.push(item);
    if (next.length === 4) break;
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return 0;
  draft[questionKey] = next;
  return 1;
}
function normalizedModelJson(raw: string, projection: AiInputProjection, finalRevision = false): { text: string; fixedRepairCount: number } {
  let value = raw.trim().replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
  value = value.replace(/^```(?:json)?\s*\r?\n/i, '').replace(/\r?\n```\s*$/i, '').trim();
  const firstObject = value.indexOf('{');
  const lastObject = value.lastIndexOf('}');
  value = firstObject >= 0 && lastObject > firstObject ? value.slice(firstObject, lastObject + 1) : value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.passport_draft)) return { text: value, fixedRepairCount: 0 };
    let fixedRepairCount = 0;
    const draft = parsed.passport_draft;
    fixedRepairCount += normalizeFollowUpQuestions(draft, projection, finalRevision);
    const hints = draft.administrative_hints;
    if (!isRecord(hints)) return { text: value, fixedRepairCount: 0 };
    const current = hints.invoice_fields_required;
    const matches = Array.isArray(current) && current.length === REQUIRED_INVOICE_FIELDS.length && REQUIRED_INVOICE_FIELDS.every((field, index) => current[index] === field);
    if (!matches) { hints.invoice_fields_required = [...REQUIRED_INVOICE_FIELDS]; fixedRepairCount += 1; }
    if (!supportedByApplicant(hints.requested_tool, projection) && hints.requested_tool !== 'unknown') {
      hints.requested_tool = 'unknown';
      fixedRepairCount += 1;
    }
    const addedUnknownFields: string[] = [];
    if (isRecord(draft.retention)) {
      const retention = draft.retention;
      const nodes = Array.isArray(draft.nodes) ? draft.nodes.filter(isRecord) : [];
      const storage = retention.storage_location;
      const supportedStorage = typeof storage === 'string' && storage.startsWith('node_')
        ? nodes.some((node) => node.id === storage && supportedByApplicant(node.label, projection))
        : supportedByApplicant(storage, projection);
      for (const [key, supported] of [
        ['storage_location', supportedStorage],
        ['duration', supportedByApplicant(retention.duration, projection)],
        ['deletion_plan', supportedByApplicant(retention.deletion_plan, projection)],
      ] as const) {
        if (!supported && retention[key] !== 'unknown') {
          retention[key] = 'unknown';
          addedUnknownFields.push(`retention.${key}`);
          fixedRepairCount += 1;
        }
      }
      if (addedUnknownFields.length > 0 && retention.needs_confirmation !== true) {
        retention.needs_confirmation = true;
        fixedRepairCount += 1;
      }
    }
    if (hints.requested_tool === 'unknown') addedUnknownFields.push('administrative_hints.requested_tool');
    if (isRecord(draft.audit) && Array.isArray(draft.audit.unknown_fields)) {
      const next = [...new Set([
        ...draft.audit.unknown_fields.filter((field): field is string => typeof field === 'string' && !ANSWER_FIELD_NAMES.has(field)),
        ...addedUnknownFields,
      ])];
      if (JSON.stringify(next) !== JSON.stringify(draft.audit.unknown_fields)) {
        draft.audit.unknown_fields = next;
        fixedRepairCount += 1;
      }
    }
    return { text: fixedRepairCount > 0 ? JSON.stringify(parsed) : value, fixedRepairCount };
  } catch {
    return { text: value, fixedRepairCount: 0 };
  }
}
function boundedInvalidStructure(raw: string, projection: AiInputProjection, finalRevision: boolean): unknown {
  const normalized = normalizedModelJson(raw, projection, finalRevision).text;
  if (new TextEncoder().encode(normalized).byteLength > MAX_PASSPORT_JSON_BYTES) return null;
  try { return JSON.parse(normalized); } catch { return null; }
}
function clearFinalRevisionFollowUps(passport: FlowPassPassport | null, finalRevision: boolean): number {
  if (!finalRevision || !passport || passport.follow_up_questions.length === 0) return 0;
  passport.follow_up_questions = [];
  return 1;
}
function semanticRewriteIssues(passport: FlowPassPassport, projection: AiInputProjection): ValidationIssue[] {
  const issues = collectPassportDiagnostics(passport).filter((issue) => issue.code === 'public_without_destination_flow');
  const needsSafetyAction = passport.sharing_scope.audience === 'public' || passport.nodes.some((node) => node.sensitivity === 'high' || node.sensitivity === 'medium');
  if (needsSafetyAction && passport.safety_actions.length === 0) {
    issues.push({
      code: 'missing_safety_action',
      category: 'readiness',
      severity: 'warning',
      path: '$.passport_draft.safety_actions',
      message: '公開或可能包含敏感資料的流程至少需要一項有依據的安全確認措施。',
    });
  }
  const visibleText: Array<{ path: string; value: string }> = [
    { path: '$.passport_draft.use_case.title', value: passport.use_case.title },
    { path: '$.passport_draft.use_case.purpose', value: passport.use_case.purpose },
    { path: '$.passport_draft.use_case.intended_outcome', value: passport.use_case.intended_outcome },
    { path: '$.passport_draft.retention.storage_location', value: passport.retention.storage_location },
    { path: '$.passport_draft.retention.duration', value: passport.retention.duration },
    { path: '$.passport_draft.retention.deletion_plan', value: passport.retention.deletion_plan },
    { path: '$.passport_draft.administrative_hints.requested_tool', value: passport.administrative_hints.requested_tool },
    ...passport.nodes.map((node, index) => ({ path: `$.passport_draft.nodes[${index}].label`, value: node.label })),
    ...passport.edges.map((edge, index) => ({ path: `$.passport_draft.edges[${index}].purpose`, value: edge.purpose })),
    ...passport.safety_actions.flatMap((action, index) => [
      { path: `$.passport_draft.safety_actions[${index}].action`, value: action.action },
      { path: `$.passport_draft.safety_actions[${index}].reason`, value: action.reason },
    ]),
    ...passport.follow_up_questions.flatMap((question, index) => [
      { path: `$.passport_draft.follow_up_questions[${index}].prompt`, value: question.prompt },
      { path: `$.passport_draft.follow_up_questions[${index}].reason`, value: question.reason },
    ]),
  ];
  visibleText.forEach(({ path, value }) => {
    if (!hasApplicantInternalReference(value)) return;
    issues.push({
      code: 'internal_reference_in_visible_copy',
      category: 'readiness',
      severity: 'warning',
      path,
      message: '申請人會看到的文字不可包含內部欄位、容器名稱、題號或 JSON 路徑，請改寫為自然繁體中文。',
    });
  });
  passport.follow_up_questions.forEach((question, index) => {
    if (followUpIsGrounded(question, projection)) return;
    issues.push({
      code: 'ungrounded_follow_up_question',
      category: 'readiness',
      severity: 'warning',
      path: `$.passport_draft.follow_up_questions[${index}]`,
      message: '這個追問沒有對應的未知資料，或申請人已經回答過相同主題；請刪除，不要用範本問題取代。',
    });
  });
  return issues;
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
  const finalRevision = payload.operation === 'revise';
  let normalized = normalizedModelJson(result.content, projection, finalRevision);
  let inspection = inspectPassportJson(normalized.text);
  let repairCount = normalized.fixedRepairCount + clearFinalRevisionFollowUps(inspection.canonical, finalRevision);
  let schemaRewriteCount = 0;
  let semanticIssues = inspection.validation.ok && inspection.canonical ? semanticRewriteIssues(inspection.canonical, projection) : [];
  while ((!inspection.validation.ok || !inspection.canonical || semanticIssues.length > 0) && schemaRewriteCount < MAX_SCHEMA_REWRITES) {
    schemaRewriteCount += 1;
    repairCount += 1;
    try {
      const repaired = await options.client.complete({
        systemInstruction: FIXED_AI_INSTRUCTION,
        inputEnvelope: projection,
        repairIssues: inspection.validation.ok ? semanticIssues : inspection.validation.errors,
        invalidStructure: inspection.canonical ?? boundedInvalidStructure(result.content, projection, finalRevision),
      });
      normalized = normalizedModelJson(repaired.content, projection, finalRevision);
      repairCount += normalized.fixedRepairCount;
      inspection = inspectPassportJson(normalized.text);
      repairCount += clearFinalRevisionFollowUps(inspection.canonical, finalRevision);
      semanticIssues = inspection.validation.ok && inspection.canonical ? semanticRewriteIssues(inspection.canonical, projection) : [];
      result = { ...repaired, inputTokens: result.inputTokens, outputTokens: repaired.outputTokens };
    } catch (error) {
      if (error instanceof LmStudioError) throw error;
      throw new LmStudioError('AI_OUTPUT_INVALID');
    }
  }
  if (!inspection.validation.ok || !inspection.canonical || semanticIssues.length > 0) throw new LmStudioError('AI_OUTPUT_INVALID');
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
