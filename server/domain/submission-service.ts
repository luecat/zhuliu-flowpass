import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../db/connection';
import type { FieldCrypto } from '../crypto/field-crypto';
import { appendEncryptedAuditLog } from '../db/repositories/audit';
import { getCaseForApplicant, type ApplicantCaseRecord } from '../db/repositories/cases';
import { listDocumentFieldsForApplicant, insertInvoiceFingerprintForSystem } from '../db/repositories/documents';
import { getPurchaseDetailsForSystem } from '../db/repositories/purchase-details';
import { insertPublicNotificationJobForSystem } from '../db/repositories/notifications';
import { inspectPassportDocument } from './passport-validation';
import { decryptDatabaseText } from '../db/repositories/encrypted-fields';
import { parseQuotedEtag } from '../../shared/api-contract';
import { evaluateEligibility } from './eligibility-rules';
import { findDuplicateInvoice } from './invoice-duplicate-service';
import { calculateSubsidy } from './subsidy-calculator';
import { persistRuleEvaluation, persistSubsidyCalculation } from '../services/rule-evaluation-service';
import { createHash } from 'node:crypto';
import type { RuleEvaluation } from '../../shared/rule-contract';
import type { DocumentRequirementKey, PurchaseDetails } from '../../shared/purchase-details-contract';

export class SubmissionCommandError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'ETAG_MISMATCH' | 'INVALID_STATE' | 'PASSPORT_NOT_READY' | 'DOCUMENT_NOT_READY' | 'INVALID_REQUEST', message = code) {
    super(message);
    this.name = 'SubmissionCommandError';
  }
}

export interface SubmissionResult {
  case: ApplicantCaseRecord;
  passportVersionId: string;
  submittedAt: string;
}

export interface SubmissionServiceOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  clock?: () => Date;
  idGenerator?: () => string;
  requestIdGenerator?: () => string;
}

export interface SubmissionService {
  submit(input: { applicantId: string; caseId: string; passportVersionId: string; ifMatch: string }): SubmissionResult;
}

interface CaseRow {
  id: string;
  applicant_id: string;
  state: string;
  current_answer_version_id: string | null;
  current_passport_version_id: string | null;
  submitted_answer_version_id: string | null;
  submitted_passport_version_id: string | null;
  program_rule_version_id: string;
  row_version: number;
}

interface PassportVersionRow {
  id: string;
  passport_id: string;
  workflow_state: string;
  answer_version_id: string;
  program_rule_version_id: string;
  payload_enc: string;
}

interface ProgramRuleRow {
  application_start_at: string | null;
  application_end_at: string | null;
  purchase_start_at: string | null;
  purchase_end_at: string | null;
  subsidy_rate_bps: number;
  per_case_cap_twd: number;
  rounding_mode: 'floor' | 'half_up';
}

interface InvoiceEvidence {
  documentId: string;
  invoiceNumber: string | null;
  invoiceAt: string | null;
  purchaseAt: string | null;
  amountMinor: string | null;
  currency: string | null;
}

function transactionally<T>(database: FlowPassDatabase, callback: () => T): T {
  return database.transaction(callback)();
}

function requiredDocumentKeys(details: PurchaseDetails): DocumentRequirementKey[] {
  return [
    'identity_front',
    'identity_back',
    ...(details.specialStatus ? ['special_status_proof' as const] : []),
    'purchase_proof',
    'passbook_cover',
    'affidavit',
    ...(details.payerType === 'representative' ? ['representative_affidavit' as const] : []),
  ];
}

function assertDocumentsReady(
  database: FlowPassDatabase,
  caseId: string,
  details: PurchaseDetails,
): string {
  let purchaseProofDocumentId: string | null = null;
  for (const requirementKey of requiredDocumentKeys(details)) {
    const document = database.prepare(`
      SELECT id
      FROM documents
      WHERE case_id = ? AND requirement_key = ? AND status = 'ready' AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(caseId, requirementKey) as { id: string } | undefined;
    if (!document) throw new SubmissionCommandError('DOCUMENT_NOT_READY');
    if (requirementKey === 'purchase_proof') purchaseProofDocumentId = document.id;
  }
  if (!purchaseProofDocumentId) throw new SubmissionCommandError('DOCUMENT_NOT_READY');
  return purchaseProofDocumentId;
}

function assertPassportReady(database: FlowPassDatabase, crypto: FieldCrypto, row: PassportVersionRow): void {
  if (row.workflow_state !== 'confirmed') throw new SubmissionCommandError('PASSPORT_NOT_READY');
  let payload: unknown;
  try {
    payload = JSON.parse(decryptDatabaseText(crypto, 'passport_versions', 'payload_enc', row.id, row.payload_enc));
  } catch {
    throw new SubmissionCommandError('PASSPORT_NOT_READY');
  }
  const inspection = inspectPassportDocument({ passport_draft: payload });
  if (!inspection.canonical || inspection.diagnostics.some((issue) => issue.severity === 'error')) throw new SubmissionCommandError('PASSPORT_NOT_READY');
}

function readInvoiceEvidence(database: FlowPassDatabase, crypto: FieldCrypto, applicantId: string, caseId: string, documentId: string, details: PurchaseDetails): InvoiceEvidence {
  const fields = listDocumentFieldsForApplicant(database, { applicantId }, crypto, caseId);
  const values = new Map<string, string | null>();
  for (const field of fields) {
    if (field.documentId !== documentId) continue;
    values.set(field.fieldName, field.effectiveValue ?? field.normalizedValue);
  }
  return {
    documentId,
    invoiceNumber: values.get('invoice_number') ?? null,
    invoiceAt: `${details.purchaseDate}T00:00:00.000Z`,
    purchaseAt: `${details.purchaseDate}T00:00:00.000Z`,
    amountMinor: String(details.convertedTwd * 100),
    currency: 'TWD',
  };
}

function ruleEvaluation(input: { ruleCode: string; outcome: RuleEvaluation['outcome']; reasonCode: string; explanation: string; ruleVersionId: string; inputSnapshotHash: string; evaluatedAt: string; steps?: RuleEvaluation['steps'] }): RuleEvaluation {
  return { ruleCode: input.ruleCode, outcome: input.outcome, reasonCode: input.reasonCode, explanation: input.explanation, ruleVersionId: input.ruleVersionId, inputSnapshotHash: input.inputSnapshotHash, evaluatedAt: input.evaluatedAt, steps: input.steps ?? [] };
}

function persistSubmissionRules(input: { database: FlowPassDatabase; crypto: FieldCrypto; caseId: string; passportVersionId: string; applicantId: string; ruleVersionId: string; rule: ProgramRuleRow; submittedAt: string; invoice: InvoiceEvidence | null; idGenerator: () => string }): { calculatedAmountTwd: number | null } {
  const snapshot = createHash('sha256').update(JSON.stringify({ caseId: input.caseId, passportVersionId: input.passportVersionId, submissionAt: input.submittedAt, applicationStartAt: input.rule.application_start_at, applicationEndAt: input.rule.application_end_at, purchaseStartAt: input.rule.purchase_start_at, purchaseEndAt: input.rule.purchase_end_at, invoice: input.invoice ? { documentId: input.invoice.documentId, invoiceNumber: input.invoice.invoiceNumber, invoiceAt: input.invoice.invoiceAt, purchaseAt: input.invoice.purchaseAt, amountMinor: input.invoice.amountMinor, currency: input.invoice.currency } : null })).digest('hex');
  const eligibility = evaluateEligibility({ submissionAt: input.submittedAt, applicationStartAt: input.rule.application_start_at, applicationEndAt: input.rule.application_end_at, purchaseAt: input.invoice?.purchaseAt ?? null, purchaseStartAt: input.rule.purchase_start_at, purchaseEndAt: input.rule.purchase_end_at, ruleVersionId: input.ruleVersionId, inputSnapshotHash: snapshot, evaluatedAt: input.submittedAt });
  persistRuleEvaluation(input.database, { caseId: input.caseId, passportVersionId: input.passportVersionId, documentId: input.invoice?.documentId ?? null, ruleVersionId: input.ruleVersionId, evaluationKind: 'submission', evaluation: eligibility.submission, actorType: 'system', actorId: 'submission-service', createdAt: input.submittedAt, idGenerator: input.idGenerator });
  persistRuleEvaluation(input.database, { caseId: input.caseId, passportVersionId: input.passportVersionId, documentId: input.invoice?.documentId ?? null, ruleVersionId: input.ruleVersionId, evaluationKind: 'invoice', evaluation: eligibility.purchase, actorType: 'system', actorId: 'submission-service', createdAt: input.submittedAt, idGenerator: input.idGenerator });

  const duplicate = input.invoice?.invoiceNumber ? findDuplicateInvoice(input.database, input.crypto, { invoiceNumber: input.invoice.invoiceNumber, excludeDocumentId: input.invoice.documentId }) : null;
  const duplicateEvaluation = ruleEvaluation({ ruleCode: 'invoice_duplicate', outcome: duplicate?.outcome ?? 'missing', reasonCode: duplicate ? duplicate.outcome === 'needs_review' ? 'duplicate_candidate' : 'no_duplicate_candidate' : 'invoice_number_missing', explanation: duplicate?.outcome === 'needs_review' ? '發票號碼存在重複候選，待人工覆核。' : duplicate ? '目前沒有相同發票號碼候選。' : '發票號碼尚未確認。', ruleVersionId: input.ruleVersionId, inputSnapshotHash: snapshot, evaluatedAt: input.submittedAt, steps: [{ label: '重複候選', value: duplicate?.outcome === 'needs_review' ? '待人工覆核' : duplicate ? '未發現' : '待確認' }] });
  persistRuleEvaluation(input.database, { caseId: input.caseId, passportVersionId: input.passportVersionId, documentId: input.invoice?.documentId ?? null, ruleVersionId: input.ruleVersionId, evaluationKind: 'invoice', evaluation: duplicateEvaluation, actorType: 'system', actorId: 'submission-service', createdAt: input.submittedAt, idGenerator: input.idGenerator });
  if (input.invoice?.invoiceNumber) {
    const existingFingerprint = input.database.prepare('SELECT id FROM invoice_fingerprints WHERE document_id = ?').get(input.invoice.documentId) as { id: string } | undefined;
    if (!existingFingerprint) insertInvoiceFingerprintForSystem(input.database, { systemId: 'submission-service' }, input.crypto, { id: input.idGenerator(), documentId: input.invoice.documentId, caseId: input.caseId, normalizedInvoiceValue: input.invoice.invoiceNumber, createdAt: input.submittedAt });
  }

  let calculation: ReturnType<typeof calculateSubsidy> | null = null;
  if (input.invoice?.currency === 'TWD' && input.invoice.amountMinor && /^\d+$/.test(input.invoice.amountMinor)) {
    const amountTwd = BigInt(input.invoice.amountMinor) / BigInt(100);
    if (amountTwd <= BigInt(Number.MAX_SAFE_INTEGER)) calculation = calculateSubsidy({ eligiblePurchaseTwd: Number(amountTwd), rateBps: input.rule.subsidy_rate_bps, capTwd: input.rule.per_case_cap_twd, roundingMode: input.rule.rounding_mode });
  }
  const subsidyEvaluation = ruleEvaluation({ ruleCode: 'subsidy_estimate', outcome: calculation ? 'pass' : 'missing', reasonCode: calculation ? calculation.reasonCode : 'amount_or_currency_missing', explanation: calculation ? '依目前公開規則試算，最終以人工審核為準。' : '金額或幣別尚未確認。', ruleVersionId: input.ruleVersionId, inputSnapshotHash: snapshot, evaluatedAt: input.submittedAt, steps: [{ label: '預估補助', value: calculation ? `NT$${calculation.calculatedAmountTwd}` : '待確認' }] });
  const subsidyEvaluationRow = persistRuleEvaluation(input.database, { caseId: input.caseId, passportVersionId: input.passportVersionId, documentId: input.invoice?.documentId ?? null, ruleVersionId: input.ruleVersionId, evaluationKind: 'subsidy', evaluation: subsidyEvaluation, actorType: 'system', actorId: 'submission-service', createdAt: input.submittedAt, idGenerator: input.idGenerator });
  if (calculation) persistSubsidyCalculation(input.database, { caseId: input.caseId, ruleEvaluationId: subsidyEvaluationRow.id, calculation, createdAt: input.submittedAt, idGenerator: input.idGenerator });
  return { calculatedAmountTwd: calculation?.calculatedAmountTwd ?? null };
}

export function createSubmissionService(options: SubmissionServiceOptions): SubmissionService {
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? uuidv7;
  const requestIdGenerator = options.requestIdGenerator ?? uuidv7;
  const systemScope = { systemId: 'submission-service' } as const;

  return {
    submit(input) {
      const expected = parseQuotedEtag(input.ifMatch);
      if (expected === null) throw new SubmissionCommandError('INVALID_REQUEST');
      return transactionally(options.database, () => {
        const submittedAt = clock().toISOString();
        const row = options.database.prepare('SELECT * FROM cases WHERE id = ? AND applicant_id = ? AND deleted_at IS NULL').get(input.caseId, input.applicantId) as CaseRow | undefined;
        if (!row) throw new SubmissionCommandError('NOT_FOUND');
        if (row.row_version !== expected) throw new SubmissionCommandError('ETAG_MISMATCH');
        if (row.state !== 'draft') throw new SubmissionCommandError('INVALID_STATE');
        if (!row.current_passport_version_id || row.current_passport_version_id !== input.passportVersionId || !row.current_answer_version_id) throw new SubmissionCommandError('PASSPORT_NOT_READY');
        const passport = options.database.prepare(`SELECT * FROM passport_versions WHERE id = ? AND answer_version_id = ? AND program_rule_version_id = ?`).get(input.passportVersionId, row.current_answer_version_id, row.program_rule_version_id) as PassportVersionRow | undefined;
        if (!passport) throw new SubmissionCommandError('PASSPORT_NOT_READY');
        assertPassportReady(options.database, options.crypto, passport);
        let purchaseDetails;
        try {
          purchaseDetails = getPurchaseDetailsForSystem(
            options.database,
            systemScope,
            options.crypto,
            input.caseId,
          );
        } catch {
          throw new SubmissionCommandError('DOCUMENT_NOT_READY');
        }
        if (!purchaseDetails) throw new SubmissionCommandError('DOCUMENT_NOT_READY');
        const purchaseProofDocumentId = assertDocumentsReady(options.database, input.caseId, purchaseDetails.details);
        const rule = options.database.prepare('SELECT application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode FROM program_rule_versions WHERE id = ?').get(row.program_rule_version_id) as ProgramRuleRow | undefined;
        if (!rule) throw new SubmissionCommandError('INVALID_STATE');
        let invoice: InvoiceEvidence;
        try { invoice = readInvoiceEvidence(options.database, options.crypto, input.applicantId, input.caseId, purchaseProofDocumentId, purchaseDetails.details); } catch { throw new SubmissionCommandError('DOCUMENT_NOT_READY'); }
        const rules = persistSubmissionRules({ database: options.database, crypto: options.crypto, caseId: input.caseId, passportVersionId: input.passportVersionId, applicantId: input.applicantId, ruleVersionId: row.program_rule_version_id, rule, submittedAt, invoice, idGenerator });

        const transitionSequence = ((options.database.prepare('SELECT COALESCE(MAX(sequence_no), 0) AS max FROM case_state_transitions WHERE case_id = ?').get(input.caseId) as { max: number }).max) + 1;
        options.database.prepare(`INSERT INTO case_state_transitions (id, case_id, sequence_no, from_state, to_state, reason_code, reason_enc, actor_type, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'applicant', ?, ?)`).run(idGenerator(), input.caseId, transitionSequence, 'draft', 'submitted', 'submitted', input.applicantId, submittedAt);
        const timelineSequence = ((options.database.prepare('SELECT COALESCE(MAX(sequence_no), 0) AS max FROM timeline_events WHERE case_id = ?').get(input.caseId) as { max: number }).max) + 1;
        options.database.prepare(`INSERT INTO timeline_events (id, case_id, sequence_no, passport_version_id, event_type, public_summary, public_data_json, actor_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(idGenerator(), input.caseId, timelineSequence, input.passportVersionId, 'case_submitted', '申請已送出', JSON.stringify({ state: 'submitted' }), 'applicant', submittedAt);
        options.database.prepare(`UPDATE cases SET state = 'submitted', submitted_answer_version_id = ?, submitted_passport_version_id = ?, requested_amount_twd = ?, calculated_amount_twd = ?, submitted_at = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND state = 'draft' AND row_version = ?`).run(row.current_answer_version_id, input.passportVersionId, purchaseDetails.details.convertedTwd, rules.calculatedAmountTwd, submittedAt, submittedAt, input.caseId, expected);
        appendEncryptedAuditLog(options.database, options.crypto, { id: idGenerator(), actorType: 'applicant', actorId: input.applicantId, action: 'update', entityType: 'case', entityId: input.caseId, beforeHash: null, afterHash: null, detail: { kind: 'transition', previousState: 'draft', nextState: 'submitted', reasonCode: 'submitted' }, requestId: requestIdGenerator(), createdAt: submittedAt });
        try {
          insertPublicNotificationJobForSystem(options.database, systemScope, {
            id: idGenerator(), caseId: input.caseId, taskId: null, alertId: null, businessKey: `submission_ack:${input.caseId}:${input.passportVersionId}`, template: 'submission_acknowledged', payload: { notificationType: 'submission', messageCode: 'submission_acknowledged', locale: 'zh-TW', publicPath: '/app/passports' }, providerRetryKey: `submission-ack-${input.caseId}-${input.passportVersionId}`, status: 'pending', attempts: 0, availableAt: submittedAt, createdAt: submittedAt,
          });
        } catch {
          // The notification is an outbox side effect. A later worker can recover
          // it; an outbox failure must not undo the submitted application.
        }
        const publicCase = getCaseForApplicant(options.database, { applicantId: input.applicantId }, input.caseId);
        if (!publicCase) throw new SubmissionCommandError('NOT_FOUND');
        return { case: publicCase, passportVersionId: input.passportVersionId, submittedAt };
      });
    },
  };
}
