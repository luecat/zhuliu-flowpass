import { describe, expect, it } from 'vitest'; import { findDuplicateInvoice, invoiceFingerprint } from './invoice-duplicate-service';
describe('invoice duplicates', () => {
  it('uses a crypto HMAC and never exposes source details', () => { const crypto = { hmacLookup: (value: string, purpose: string) => `${purpose}:${value}` }; const result = invoiceFingerprint(crypto as never, ' A123 '); expect(result).toBe('invoice-fingerprint:A123'); expect(result).not.toContain('applicant'); });
  it('returns an applicant-safe review outcome without a candidate count', () => {
    const crypto = { hmacLookup: (value: string, purpose: string) => `${purpose}:${value}` };
    const database = { prepare: () => ({ get: () => ({ duplicate: 1 }) }) };
    const result = findDuplicateInvoice(database as never, crypto as never, { invoiceNumber: 'A123', excludeDocumentId: 'current' });
    expect(result).toEqual({ outcome: 'needs_review' });
    expect(result).not.toHaveProperty('candidateCount');
  });
});
