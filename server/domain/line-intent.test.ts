import { describe, expect, it } from 'vitest';
import { classifyLineIntent, subsidyPolicyReply } from './line-intent';

describe('subsidyPolicyReply', () => {
  it('states the published rate and cap instead of fixed amounts', () => {
    const reply = subsidyPolicyReply({ rateBps: 5000, capTwd: 10000 });
    expect(reply).toContain('50%');
    expect(reply).toContain('NT$10,000');
    expect(reply).not.toMatch(/3,000|6,000/);
    expect(subsidyPolicyReply(null)).toContain('沒有開放中的補助方案');
  });
});

describe('classifyLineIntent', () => {
  it('routes FAQ, case status, subsidy, and tool status intents', () => {
    expect(classifyLineIntent('怎麼申請')).toMatchObject({ kind: 'faq' });
    expect(classifyLineIntent('常見問題')).toMatchObject({ kind: 'faq' });
    const faq = classifyLineIntent('FAQ');
    expect(faq).toMatchObject({ kind: 'faq', answer: expect.stringContaining('常見問題') });
    if (faq.kind === 'faq') expect(faq.answer).not.toMatch(/無法個別回覆/);
    expect(classifyLineIntent('護照是什麼')).toMatchObject({ kind: 'faq', answer: expect.stringContaining('護照') });
    expect(classifyLineIntent('我的案子到哪了')).toEqual({ kind: 'case_status' });
    expect(classifyLineIntent('進度查詢')).toEqual({ kind: 'case_status' });
    expect(classifyLineIntent('為什麼是這個金額')).toEqual({ kind: 'subsidy_amount' });
    expect(classifyLineIntent('補助多少')).toEqual({ kind: 'subsidy_policy' });
    expect(classifyLineIntent('檢測')).toEqual({ kind: 'tool_status', tool: '' });
    expect(classifyLineIntent('ChatGPT 出事了嗎')).toEqual({ kind: 'tool_status', tool: 'ChatGPT' });
    expect(classifyLineIntent('今天天氣如何')).toEqual({ kind: 'fallback' });
  });
});
