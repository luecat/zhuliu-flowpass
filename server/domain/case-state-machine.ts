export const CASE_STATES = [
  'draft',
  'submitted',
  'under_review',
  'awaiting_documents',
  'returned_for_correction',
  'resubmitted',
  'approved',
  'rejected',
  'awaiting_disbursement',
  'disbursed',
  'closed',
] as const;

export type CaseState = (typeof CASE_STATES)[number];

export const ALLOWED_CASE_TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  draft: ['submitted'],
  submitted: ['under_review'],
  under_review: ['awaiting_documents', 'returned_for_correction', 'approved', 'rejected'],
  awaiting_documents: ['resubmitted'],
  returned_for_correction: ['resubmitted'],
  resubmitted: ['under_review'],
  approved: ['awaiting_disbursement'],
  rejected: [],
  awaiting_disbursement: ['disbursed'],
  disbursed: ['closed'],
  closed: [],
};

export type CaseTransitionAction =
  | 'submit'
  | 'start_review'
  | 'request_documents'
  | 'return_correction'
  | 'approve'
  | 'reject'
  | 'await_disbursement'
  | 'disburse'
  | 'close'
  | 'manual_override';

export type CaseStateMachineErrorCode =
  | 'INVALID_STATE'
  | 'FORBIDDEN_TRANSITION'
  | 'REASON_REQUIRED'
  | 'INVALID_APPROVED_AMOUNT'
  | 'APPROVED_AMOUNT_EXCEEDS_CAP'
  | 'INVALID_DISBURSED_AMOUNT'
  | 'INVALID_ACTION';

export class CaseStateMachineError extends Error {
  constructor(readonly code: CaseStateMachineErrorCode, message: string = code) {
    super(message);
    this.name = 'CaseStateMachineError';
  }
}

const REQUIRED_REASON_ACTIONS = new Set<CaseTransitionAction>([
  'request_documents',
  'return_correction',
  'approve',
  'reject',
  'await_disbursement',
  'disburse',
  'close',
  'manual_override',
]);

const ACTION_DESTINATIONS: Readonly<Partial<Record<CaseTransitionAction, CaseState>>> = {
  submit: 'submitted',
  start_review: 'under_review',
  request_documents: 'awaiting_documents',
  return_correction: 'returned_for_correction',
  approve: 'approved',
  reject: 'rejected',
  await_disbursement: 'awaiting_disbursement',
  disburse: 'disbursed',
  close: 'closed',
};

function isCaseState(value: string): value is CaseState {
  return (CASE_STATES as readonly string[]).includes(value);
}

function requireValidState(value: string, field: string): asserts value is CaseState {
  if (!isCaseState(value)) {
    throw new CaseStateMachineError('INVALID_STATE', `${field} is not a case state`);
  }
}

function requireReason(reason: string | undefined): void {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new CaseStateMachineError('REASON_REQUIRED', 'A non-empty reason is required');
  }
}

export interface CaseTransitionInput {
  from: CaseState | string;
  to: CaseState | string;
  action?: CaseTransitionAction;
  reason?: string;
  approvedAmountTwd?: number;
  disbursedAmountTwd?: number;
  capTwd?: number;
  overrideReason?: string;
  manualOverride?: boolean;
}

/**
 * Validates a state command without touching persistence. Free-form reasons are
 * intentionally only checked for presence here; callers encrypt the verbatim
 * value in the transition/decision owner.
 */
export function assertCaseTransition(input: CaseTransitionInput): void {
  requireValidState(input.from, 'from');
  requireValidState(input.to, 'to');

  if (input.from === input.to) {
    throw new CaseStateMachineError('FORBIDDEN_TRANSITION', 'A case cannot transition to its current state');
  }

  if (input.action === 'manual_override' || input.manualOverride === true) {
    if (input.action !== undefined && input.action !== 'manual_override') {
      throw new CaseStateMachineError('INVALID_ACTION', 'Manual override must use the manual_override action');
    }
    requireReason(input.reason);
    return;
  }

  if (input.action) {
    const expectedDestination = ACTION_DESTINATIONS[input.action];
    if (expectedDestination !== undefined && expectedDestination !== input.to) {
      throw new CaseStateMachineError('INVALID_ACTION', 'Action does not match destination state');
    }
  }

  if (!ALLOWED_CASE_TRANSITIONS[input.from].includes(input.to)) {
    throw new CaseStateMachineError('FORBIDDEN_TRANSITION', `${input.from} cannot transition to ${input.to}`);
  }

  const actionRequiresReason = input.action ? REQUIRED_REASON_ACTIONS.has(input.action) : false;
  const destinationRequiresReason = new Set<CaseState>([
    'awaiting_documents',
    'returned_for_correction',
    'approved',
    'rejected',
    'awaiting_disbursement',
    'disbursed',
    'closed',
  ]).has(input.to);
  if (actionRequiresReason || destinationRequiresReason) {
    requireReason(input.reason);
  }

  if (input.to === 'approved' || input.action === 'approve') {
    if (!Number.isSafeInteger(input.approvedAmountTwd) || (input.approvedAmountTwd as number) < 0) {
      throw new CaseStateMachineError('INVALID_APPROVED_AMOUNT', 'approved_amount_twd must be a non-negative integer');
    }
    if (!Number.isSafeInteger(input.capTwd) || (input.capTwd as number) < 0) {
      throw new CaseStateMachineError('INVALID_APPROVED_AMOUNT', 'A non-negative configured cap is required');
    }
    if ((input.approvedAmountTwd as number) > (input.capTwd as number)) {
      if (typeof input.overrideReason !== 'string' || input.overrideReason.trim().length === 0) {
        throw new CaseStateMachineError('APPROVED_AMOUNT_EXCEEDS_CAP', 'Approved amount exceeds the configured cap');
      }
    }
  }

  if (input.to === 'disbursed' || input.action === 'disburse') {
    if (!Number.isSafeInteger(input.disbursedAmountTwd) || (input.disbursedAmountTwd as number) < 0) {
      throw new CaseStateMachineError('INVALID_DISBURSED_AMOUNT', 'disbursed_amount_twd must be a non-negative integer');
    }
  }
}

export function isAllowedCaseTransition(from: string, to: string): boolean {
  if (!isCaseState(from) || !isCaseState(to)) return false;
  return ALLOWED_CASE_TRANSITIONS[from].includes(to);
}
