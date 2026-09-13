import { describe, expect, it } from 'vitest';
import { classifyLineIntent } from './line-intent';

describe('classifyLineIntent', () => {
  it('routes FAQ, case status, subsidy, and tool status intents', () => {
    expect(classifyLineIntent('怎麼申請')).toMatchObject({ kind: 'faq' });
    expect(classifyLineIntent('常見問題')).toMatchObject({ kind: 'faq' });
    expect(classifyLineIntent('FAQ')).toMatchObject({ kind: 'faq', answer: expect.stringContaining('請從 LINE 選單') });
    expect(classifyLineIntent('我的案子到哪了')).toEqual({ kind: 'case_status' });
    expect(classifyLineIntent('進度查詢')).toEqual({ kind: 'case_status' });
    expect(classifyLineIntent('為什麼是這個金額')).toEqual({ kind: 'subsidy_amount' });
    expect(classifyLineIntent('檢測')).toEqual({ kind: 'tool_status', tool: '' });
    expect(classifyLineIntent('ChatGPT 出事了嗎')).toEqual({ kind: 'tool_status', tool: 'ChatGPT' });
    expect(classifyLineIntent('今天天氣如何')).toEqual({ kind: 'fallback' });
  });
});
