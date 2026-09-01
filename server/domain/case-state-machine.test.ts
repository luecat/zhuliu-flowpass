import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CASE_TRANSITIONS,
  CaseStateMachineError,
  assertCaseTransition,
  type CaseState,
} from './case-state-machine';

const allowed: Array<[CaseState, CaseState]> = [
  ['draft', 'submitted'],
  ['submitted', 'under_review'],
  ['under_review', 'awaiting_documents'],
  ['under_review', 'returned_for_correction'],
  ['under_review', 'approved'],
  ['under_review', 'rejected'],
  ['awaiting_documents', 'resubmitted'],
  ['returned_for_correction', 'resubmitted'],
  ['resubmitted', 'under_review'],
  ['approved', 'awaiting_disbursement'],
  ['awaiting_disbursement', 'disbursed'],
  ['disbursed', 'closed'],
];

describe('case state machine', () => {
  it('encodes every contract transition and rejects all other ordinary transitions', () => {
    expect(ALLOWED_CASE_TRANSITIONS).toMatchObject({
      draft: ['submitted'],
      submitted: ['under_review'],
      under_review: ['awaiting_documents', 'returned_for_correction', 'approved', 'rejected'],
      awaiting_documents: ['resubmitted'],
      returned_for_correction: ['resubmitted'],
      resubmitted: ['under_review'],
      approved: ['awaiting_disbursement'],
      awaiting_disbursement: ['disbursed'],
      disbursed: ['closed'],
    });

    for (const [from, to] of allowed) {
      expect(() => assertCaseTransition({
        from,
        to,
        ...(to === 'approved' ? { reason: '符合規則', approvedAmountTwd: 0, capTwd: 10000 } : {}),
        ...(to === 'disbursed' ? { disbursedAmountTwd: 0 } : {}),
        ...(to !== 'approved' && ['awaiting_documents', 'returned_for_correction', 'rejected', 'awaiting_disbursement', 'disbursed', 'closed'].includes(to) ? { reason: '作業依據' } : {}),
      })).not.toThrow();
    }

    const states = Object.keys(ALLOWED_CASE_TRANSITIONS) as CaseState[];
    for (const from of states) {
      for (const to of states) {
        if (!allowed.some(([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to)) {
          expect(() => assertCaseTransition({ from, to })).toThrow(CaseStateMachineError);
        }
      }
    }
  });

  it('requires non-empty reasons for consequential admin decisions', () => {
    const required = [
      ['under_review', 'awaiting_documents'],
      ['under_review', 'returned_for_correction'],
      ['under_review', 'approved'],
      ['under_review', 'rejected'],
      ['approved', 'awaiting_disbursement'],
      ['awaiting_disbursement', 'disbursed'],
      ['disbursed', 'closed'],
    ] as Array<[CaseState, CaseState]>;

    for (const [from, to] of required) {
      expect(() => assertCaseTransition({ from, to, reason: '   ' })).toThrowError(
        expect.objectContaining({ code: 'REASON_REQUIRED' }),
      );
      expect(() => assertCaseTransition({
        from,
        to,
        reason: '核定依據',
        ...(to === 'approved' ? { approvedAmountTwd: 0, capTwd: 10000 } : {}),
        ...(to === 'disbursed' ? { disbursedAmountTwd: 0 } : {}),
      })).not.toThrow();
    }

    expect(() => assertCaseTransition({ from: 'submitted', to: 'under_review' })).not.toThrow();
  });

  it('validates approved amount as an integer within cap, with an audited override escape hatch', () => {
    expect(() => assertCaseTransition({
      from: 'under_review', to: 'approved', reason: '符合規則', approvedAmountTwd: 10000, capTwd: 10000,
    })).not.toThrow();
    for (const approvedAmountTwd of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertCaseTransition({
        from: 'under_review', to: 'approved', reason: '符合規則', approvedAmountTwd, capTwd: 10000,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_APPROVED_AMOUNT' }));
    }
    expect(() => assertCaseTransition({
      from: 'under_review', to: 'approved', reason: '符合規則', approvedAmountTwd: 10001, capTwd: 10000,
    })).toThrowError(expect.objectContaining({ code: 'APPROVED_AMOUNT_EXCEEDS_CAP' }));
    expect(() => assertCaseTransition({
      from: 'under_review', to: 'approved', reason: '特殊核准', approvedAmountTwd: 10001, capTwd: 10000,
      overrideReason: '主管核准之例外依據',
    })).not.toThrow();
    expect(() => assertCaseTransition({
      from: 'under_review', to: 'approved', reason: '特殊核准', approvedAmountTwd: 10001, capTwd: 10000,
      overrideReason: '  ',
    })).toThrowError(expect.objectContaining({ code: 'APPROVED_AMOUNT_EXCEEDS_CAP' }));
  });

  it('requires a non-negative integer transfer amount when marking a case as disbursed', () => {
    expect(() => assertCaseTransition({
      from: 'awaiting_disbursement', to: 'disbursed', reason: '已匯款', disbursedAmountTwd: 1850,
    })).not.toThrow();
    for (const disbursedAmountTwd of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertCaseTransition({
        from: 'awaiting_disbursement', to: 'disbursed', reason: '已匯款', disbursedAmountTwd,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_DISBURSED_AMOUNT' }));
    }
  });

  it('requires a reason for manual override and permits an explicitly audited destination', () => {
    expect(() => assertCaseTransition({
      from: 'rejected', to: 'under_review', action: 'manual_override', reason: '重新受理', manualOverride: true,
    })).not.toThrow();
    expect(() => assertCaseTransition({
      from: 'rejected', to: 'under_review', action: 'manual_override', reason: ' ', manualOverride: true,
    })).toThrowError(expect.objectContaining({ code: 'REASON_REQUIRED' }));
    expect(() => assertCaseTransition({
      from: 'rejected', to: 'under_review', reason: '重新受理',
    })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN_TRANSITION' }));
  });
});
