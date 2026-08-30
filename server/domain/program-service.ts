import type { FlowPassDatabase } from '../db/connection';
import {
  listActiveProgramCyclesForApplicant,
  listPublishedRuleVersionsForApplicant,
  type ApplicantProgramCycleRecord,
  type ApplicantProgramRuleVersionRecord,
} from '../db/repositories/programs';
import type { ApplicantScope } from '../db/repositories/scopes';
import type { PublicProgram } from '../../shared/rule-contract';
import { parseUtcRfc3339Timestamp } from '../db/timestamps';
import { v7 as uuidv7 } from 'uuid';

export interface ProgramServiceDependencies {
  listCycles: () => ApplicantProgramCycleRecord[];
  listRules: (cycleId?: string) => ApplicantProgramRuleVersionRecord[];
}

export interface DemoSeedWindowInput {
  applicationStart: string;
  applicationEnd: string;
  purchaseStart: string;
  purchaseEnd: string;
}

export function validateDemoSeedWindows(input: DemoSeedWindowInput): DemoSeedWindowInput {
  const applicationStart = parseUtcRfc3339Timestamp(input.applicationStart, 'applicationStart');
  const applicationEnd = parseUtcRfc3339Timestamp(input.applicationEnd, 'applicationEnd');
  const purchaseStart = parseUtcRfc3339Timestamp(input.purchaseStart, 'purchaseStart');
  const purchaseEnd = parseUtcRfc3339Timestamp(input.purchaseEnd, 'purchaseEnd');
  if (applicationStart >= applicationEnd) throw new Error('application window start must precede end');
  if (purchaseStart >= purchaseEnd) throw new Error('purchase window start must precede end');
  return { applicationStart, applicationEnd, purchaseStart, purchaseEnd };
}

export function seedDemoProgram(database: FlowPassDatabase, input: DemoSeedWindowInput, idGenerator: () => string = uuidv7): { cycleId: string; ruleId: string } {
  const windows = validateDemoSeedWindows(input);
  const now = new Date().toISOString();
  const cycleId = idGenerator();
  const ruleId = idGenerator();
  database.transaction(() => {
    database.prepare(`INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 1)`).run(cycleId, `DEMO-${now.slice(0, 10).replaceAll('-', '')}`, 'FlowPass 示範申請', new Date(now).getUTCFullYear(), '{}', now, now);
    database.prepare(`INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, created_at) VALUES (?, ?, 1, 'published', ?, ?, ?, ?, 5000, 10000, 'floor', '[]', '{"demo":true}', ?, ?)`).run(ruleId, cycleId, windows.applicationStart, windows.applicationEnd, windows.purchaseStart, windows.purchaseEnd, now, now);
  })();
  return { cycleId, ruleId };
}

/** Populate a replayable, privacy-safe applicant demo alongside the program. */
export function seedDemoFixtures(database: FlowPassDatabase, input: { cycleId: string; ruleId: string }, idGenerator: () => string = uuidv7): { applicantId: string; caseIds: string[] } {
  const now = new Date();
  const stamp = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const applicantId = idGenerator();
  const currentDraft = idGenerator();
  const currentSubmitted = idGenerator();
  const approved = idGenerator();
  const previousCycle = idGenerator();
  const previousRule = idGenerator();
  const previousCase = idGenerator();
  const ids = [currentDraft, currentSubmitted, approved, previousCase];
  const answerIds = ids.map(() => idGenerator());
  const passportIds = ids.map(() => idGenerator());
  const versionIds = ids.map(() => idGenerator());
  const taskId = idGenerator();
  const alertId = idGenerator();
  database.transaction(() => {
    database.prepare(`INSERT OR IGNORE INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version) VALUES (?, ?, 'active', ?, ?, 1)`).run(applicantId, 'demo-applicant', stamp(-10), stamp(-10));
    database.prepare(`INSERT OR IGNORE INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, 'closed', '{}', ?, ?, 1)`).run(previousCycle, `DEMO-${now.getUTCFullYear() - 1}`, 'FlowPass 去年度示範', now.getUTCFullYear() - 1, stamp(-9), stamp(-9));
    database.prepare(`INSERT OR IGNORE INTO program_rule_versions (id, program_cycle_id, version_no, status, application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, created_at) VALUES (?, ?, 1, 'retired', ?, ?, ?, ?, 5000, 10000, 'floor', '[]', '{}', ?, ?)`).run(previousRule, previousCycle, stamp(-50000), stamp(-40000), stamp(-50000), stamp(-30000), stamp(-9), stamp(-9));
    const cases = [
      { id: currentDraft, code: 'DEMO-DRAFT', state: 'draft', created: stamp(-8), submitted: null, closed: null },
      { id: currentSubmitted, code: 'DEMO-SUBMITTED', state: 'submitted', created: stamp(-7), submitted: stamp(-6), closed: null },
      { id: approved, code: 'DEMO-APPROVED', state: 'approved', created: stamp(-5), submitted: stamp(-4), closed: null },
      { id: previousCase, code: 'DEMO-CLOSED-OLD', state: 'closed', created: stamp(-100000), submitted: stamp(-99990), closed: stamp(-99980) },
    ];
    cases.forEach((item, index) => {
      const cycleId = index === 3 ? previousCycle : input.cycleId;
      const ruleId = index === 3 ? previousRule : input.ruleId;
      database.prepare(`INSERT OR IGNORE INTO cases (id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state, current_answer_version_id, current_passport_version_id, submitted_answer_version_id, submitted_passport_version_id, approved_passport_version_id, requested_amount_twd, calculated_amount_twd, approved_amount_twd, submitted_at, closed_at, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(item.id, item.code, applicantId, cycleId, ruleId, item.state, answerIds[index], versionIds[index], item.submitted ? answerIds[index] : null, item.submitted ? versionIds[index] : null, index === 2 || index === 3 ? versionIds[index] : null, 12000, 6000, index === 2 ? 6000 : null, item.submitted, item.closed, item.created, stamp(-1));
      database.prepare(`INSERT OR IGNORE INTO answer_versions (id, case_id, version_no, answers_enc, content_sha256, created_by_applicant_id, created_at) VALUES (?, ?, 1, 'demo-answers', ?, ?, ?)`).run(answerIds[index], item.id, `demo-${item.id}`, applicantId, item.created);
      database.prepare(`INSERT OR IGNORE INTO passports (id, case_id, created_at) VALUES (?, ?, ?)`).run(passportIds[index], item.id, item.created);
      database.prepare(`INSERT OR IGNORE INTO passport_versions (id, passport_id, version_no, parent_version_id, origin, workflow_state, schema_version, answer_version_id, program_rule_version_id, payload_enc, content_sha256, created_by_type, created_by_id, created_at) VALUES (?, ?, 1, NULL, 'ai_draft', ?, '1.0', ?, ?, '{}', ?, 'system', 'seed-demo', ?)`).run(versionIds[index], passportIds[index], item.state === 'draft' ? 'needs_applicant_confirmation' : 'confirmed', answerIds[index], ruleId, `demo-passport-${item.id}`, item.created);
      database.prepare(`INSERT OR IGNORE INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, 1, ?, 'submitted', '申請已送出', '{}', 'system', ?)`).run(idGenerator(), item.id, versionIds[index], item.submitted ?? item.created);
    });
    database.prepare(`INSERT OR IGNORE INTO case_tasks (id, case_id, alert_id, task_type, title, instructions_enc, accepted_document_types_json, due_at, status, created_by_type, created_by_id, completed_at, created_at, row_version) VALUES (?, ?, NULL, 'provide_document', '補上購買證明', 'demo-instructions', '["invoice"]', ?, 'open', 'system', 'seed-demo', NULL, ?, 1)`).run(taskId, currentSubmitted, stamp(24 * 60), stamp(-6));
    database.prepare(`INSERT OR IGNORE INTO alerts (id, case_id, passport_version_id, incident_match_id, kind, severity, status, public_summary, public_guidance, details_enc, created_at, resolved_at, row_version) VALUES (?, ?, ?, NULL, 'contextual', 'medium', 'open', '請確認這筆案件的資料流向。', '完成待辦前請先閱讀資料流向。', 'demo-alert', ?, NULL, 1)`).run(alertId, currentSubmitted, versionIds[1], stamp(-5));
  })();
  return { applicantId, caseIds: ids };
}

function requiredDocuments(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export function getCurrentProgram(dependencies: ProgramServiceDependencies): PublicProgram | null {
  for (const cycle of dependencies.listCycles()) {
    if (cycle.status !== 'active') continue;
    const rule = dependencies.listRules(cycle.id).find((candidate) => candidate.status === 'published');
    if (!rule) continue;
    const documents = requiredDocuments(rule.requiredDocumentsJson);
    return {
      id: cycle.id,
      code: cycle.code,
      name: cycle.name,
      year: cycle.year,
      applicationWindow: { startAt: rule.applicationStartAt, endAt: rule.applicationEndAt },
      eligiblePurchaseWindow: { startAt: rule.purchaseStartAt, endAt: rule.purchaseEndAt },
      requirements: { requiredDocuments: documents },
      rule: {
        id: rule.id,
        versionNo: rule.versionNo,
        applicationStartAt: rule.applicationStartAt,
        applicationEndAt: rule.applicationEndAt,
        purchaseStartAt: rule.purchaseStartAt,
        purchaseEndAt: rule.purchaseEndAt,
        requiredDocuments: documents,
      },
    };
  }
  return null;
}

export function createProgramService(database: FlowPassDatabase, scope: ApplicantScope): ProgramServiceDependencies {
  return {
    listCycles: () => listActiveProgramCyclesForApplicant(database, scope),
    listRules: (cycleId) => cycleId ? listPublishedRuleVersionsForApplicant(database, scope, cycleId) : [],
  };
}
