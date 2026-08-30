import { describe, expect, it } from 'vitest';
import { validateCoreAnswers, unicodeScalarLength } from './case-contract';

const valid = { material: '資料', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' };

describe('CoreAnswers contract', () => {
  it('counts Unicode scalars rather than UTF-16 units and preserves original text', () => {
    const value = '😀e\u0301';
    expect(unicodeScalarLength(value)).toBe(3);
    expect(validateCoreAnswers({ ...valid, material: value }).material).toBe(value);
  });
  it('rejects extra keys, blank fields, and scalar-over-limit values', () => {
    expect(() => validateCoreAnswers({ ...valid, extra: 'x' })).toThrow();
    expect(() => validateCoreAnswers({ ...valid, material: '   ' })).toThrow();
    expect(() => validateCoreAnswers({ ...valid, material: '😀'.repeat(501) })).toThrow();
  });
});
