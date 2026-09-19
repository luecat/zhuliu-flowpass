import type { Attachment, Case, RuleEvaluationView, Session } from './types';

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const string = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

export const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export function sessionOf(value: unknown): Session {
  const v = record(value);
  return {
    authenticated: v.authenticated === true,
    displayName: string(v.displayName ?? v.display_name ?? v.name) ?? '管理員',
    mustChangePassword: v.mustChangePassword === true || v.must_change_password === true,
    passwordExpiresAt: string(v.passwordExpiresAt ?? v.password_expires_at),
  };
}

export function caseOf(value: unknown): Case | null {
  const v = record(value), id = string(v.id);
  if (!id) return null;
  return {
    id,
    caseCode: string(v.caseCode ?? v.case_code) ?? id,
    state: string(v.state) ?? 'unknown',
    submittedAt: string(v.submittedAt ?? v.submitted_at),
    createdAt: string(v.createdAt ?? v.created_at),
    updatedAt: string(v.updatedAt ?? v.updated_at),
    rowVersion: number(v.rowVersion ?? v.row_version) ?? string(v.rowVersion ?? v.row_version),
    applicantName: string(v.applicantName ?? v.applicant_name ?? v.applicantDisplayName),
    programName: string(v.programName ?? v.program_name ?? v.programTitle),
    requestedAmountTwd: number(v.requestedAmountTwd ?? v.requested_amount_twd),
    calculatedAmountTwd: number(v.calculatedAmountTwd ?? v.calculated_amount_twd),
    approvedAmountTwd: number(v.approvedAmountTwd ?? v.approved_amount_twd),
    disbursedAmountTwd: number(v.disbursedAmountTwd ?? v.disbursed_amount_twd),
    needsReviewCount: number(v.needsReviewCount ?? v.needs_review_count) ?? 0,
  };
}

export function evaluationOf(value: unknown): RuleEvaluationView | null {
  const v = record(value), id = string(v.id), ruleCode = string(v.ruleCode ?? v.rule_code), outcome = string(v.outcome);
  if (!id || !ruleCode || !outcome) return null;
  const steps = Array.isArray(v.steps)
    ? v.steps.map((step) => {
        const item = record(step);
        const label = string(item.label);
        const stepValue = string(item.value);
        return label && stepValue ? { label, value: stepValue } : null;
      }).filter((step): step is { label: string; value: string } => step !== null)
    : [];
  return { id, ruleCode, outcome, explanation: string(v.explanation) ?? '', steps, createdAt: string(v.createdAt ?? v.created_at) };
}

export function attachmentOf(value: unknown): Attachment | null {
  const v = record(value), id = string(v.id), mediaType = string(v.mediaType ?? v.media_type), originalName = string(v.originalName ?? v.original_name), byteSize = number(v.byteSize ?? v.byte_size);
  if (!id || !mediaType || !originalName || byteSize === undefined) return null;
  return {
    id,
    kind: string(v.kind) ?? 'other',
    requirementKey: string(v.requirementKey ?? v.requirement_key),
    mediaType,
    byteSize,
    originalName,
    status: string(v.status) ?? 'unknown',
    createdAt: string(v.createdAt ?? v.created_at),
    rowVersion: number(v.rowVersion ?? v.row_version),
  };
}
