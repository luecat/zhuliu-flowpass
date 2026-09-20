import { describe, expect, it } from 'vitest';
import { validateCoreAnswers, unicodeScalarLength } from './case-contract';

const valid = {
  material: '資料',
  aiPurpose: '整理',
  sensitiveData: '無',
  destinationAndAudience: '團隊',
  requestedTool: 'ChatGPT',
  retentionDuration: '保留 30 天',
  applicantName: '測試申請人',
};

describe('CoreAnswers contract', () => {
  it('counts Unicode scalars rather than UTF-16 units and preserves original text', () => {
    const value = '😀e\u0301';
    expect(unicodeScalarLength(value)).toBe(3);
    expect(validateCoreAnswers({ ...valid, material: value }).material).toBe(value);
  });
  it('allows complete stage-1 answers without applicantName', () => {
    expect(validateCoreAnswers({
      material: '資料',
      aiPurpose: '整理',
      sensitiveData: '無',
      destinationAndAudience: '團隊',
      requestedTool: 'ChatGPT',
      retentionDuration: '保留 30 天',
    }).applicantName).toBe('');
  });
  it('rejects blank fields, bare 有 without detail, and scalar-over-limit values', () => {
    expect(() => validateCoreAnswers({ ...valid, material: '   ' })).toThrow();
    expect(() => validateCoreAnswers({ ...valid, sensitiveData: '有' })).toThrow();
    expect(() => validateCoreAnswers({ ...valid, material: '😀'.repeat(501) })).toThrow();
  });
  it('defaults missing newer fields for legacy stored answers', async () => {
    const { parseStoredCoreAnswers } = await import('./case-contract');
    const legacy = { material: '資料', aiPurpose: '整理', sensitiveData: '無', destinationAndAudience: '團隊' };
    expect(parseStoredCoreAnswers(legacy)).toMatchObject({
      applicantName: '',
      requestedTool: '',
      retentionDuration: '',
    });
  });
});
