import { describe, expect, it } from 'vitest';
import { evaluateApplicantNameConsistency, namesMatch } from './name-consistency-rules';

const base = { ruleVersionId: 'rule', inputSnapshotHash: 'h', evaluatedAt: '2026-09-19T00:00:00.000Z' };

describe('namesMatch', () => {
  it('is case- and whitespace-insensitive for latin names', () => {
    expect(namesMatch('CHEN PEI-I', '  chen   pei-i ')).toBe(true);
  });
  it('is exact for CJK names', () => {
    expect(namesMatch('陳小明', '陳小名')).toBe(false);
    expect(namesMatch('陳小明', '陳小明')).toBe(true);
  });
});

describe('evaluateApplicantNameConsistency', () => {
  it('passes the real self-card scenario from the development plan: receipt names the applicant', () => {
    const result = evaluateApplicantNameConsistency({ ...base, applicantName: '陳小明', cardholderName: null, payerType: 'self_card', receiptBuyerName: '陳小明' });
    expect(result.outcome).toBe('pass');
    expect(result.reasonCode).toBe('matches_applicant');
  });

  it('passes the real representative-payment scenario: receipt names the cardholder, payer type declared as representative', () => {
    const result = evaluateApplicantNameConsistency({ ...base, applicantName: '陳小明', cardholderName: '陳美玲', payerType: 'representative', receiptBuyerName: '陳美玲' });
    expect(result.outcome).toBe('pass');
    expect(result.reasonCode).toBe('matches_representative');
  });

  it('needs review when receipt names the cardholder but payer type is still self_card (applicant never flagged the representative)', () => {
    const result = evaluateApplicantNameConsistency({ ...base, applicantName: '陳小明', cardholderName: '陳美玲', payerType: 'self_card', receiptBuyerName: '陳美玲' });
    expect(result.outcome).toBe('needs_review');
    expect(result.reasonCode).toBe('name_mismatch');
  });

  it('needs review when the receipt name matches neither applicant nor cardholder', () => {
    const result = evaluateApplicantNameConsistency({ ...base, applicantName: '陳小明', cardholderName: '陳美玲', payerType: 'representative', receiptBuyerName: '王大同' });
    expect(result.outcome).toBe('needs_review');
  });

  it('reports missing, not a mismatch, when the receipt name has not been read yet', () => {
    const result = evaluateApplicantNameConsistency({ ...base, applicantName: '陳小明', cardholderName: null, payerType: 'self_card', receiptBuyerName: null });
    expect(result.outcome).toBe('missing');
    expect(result.reasonCode).toBe('receipt_name_unread');
  });
});
