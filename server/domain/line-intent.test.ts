import { describe, expect, it } from 'vitest';
import {
  CITY_CONSULTATION_TEL_URI,
  PROGRAM_ANNOUNCEMENT_URL,
  classifyLineIntent,
  isLineHelpKind,
  lineHelpPresentation,
  subsidyPolicyReply,
} from './line-intent';

const LIFF_ID = '2011336492-ay7OJ4mO';

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
    expect(classifyLineIntent('這是什麼')).toMatchObject({ kind: 'faq', answer: expect.stringContaining('新竹市青年') });
    const howToApply = classifyLineIntent('怎麼申請');
    expect(howToApply).toMatchObject({ kind: 'faq' });
    if (howToApply.kind === 'faq') {
      expect(howToApply.answer).toContain('官方收據');
      expect(howToApply.answer).toContain('刷卡單筆明細');
      expect(howToApply.answer).toContain('切結書');
      expect(howToApply.answer).not.toMatch(/購買發票/);
    }
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

  it('routes eligibility, city contact, and disbursement timing away from invented answers', () => {
    expect(classifyLineIntent('誰可以申請')).toEqual({ kind: 'eligibility' });
    expect(classifyLineIntent('特定對象怎麼申請')).toEqual({ kind: 'eligibility' });
    expect(classifyLineIntent('申請資格是什麼')).toEqual({ kind: 'eligibility' });
    expect(classifyLineIntent('聯絡窗口')).toEqual({ kind: 'contact_city' });
    expect(classifyLineIntent('市府電話')).toEqual({ kind: 'contact_city' });
    expect(classifyLineIntent('何時一定入帳')).toEqual({ kind: 'disbursement_timing' });
    expect(classifyLineIntent('什麼時候拿錢')).toEqual({ kind: 'disbursement_timing' });
    expect(classifyLineIntent('何時撥款')).toEqual({ kind: 'disbursement_timing' });
    expect(classifyLineIntent('撥款')).toMatchObject({ kind: 'faq', answer: expect.stringContaining('無法確認') });
  });
});

describe('lineHelpPresentation', () => {
  it('shows FAQ keywords and city contact when the question cannot be answered', () => {
    const help = lineHelpPresentation('fallback', LIFF_ID);
    expect(help.title).toBe('請改問關鍵字');
    expect(help.text).toContain('常見問題');
    expect(help.text).toContain('請於市府上班時間撥打');
    expect(help.buttons.map((button) => button.label)).toEqual(['公告', '進度查詢', '諮詢專線']);
    expect(help.buttons[0]?.uri).toBe(PROGRAM_ANNOUNCEMENT_URL);
    expect(help.buttons[1]?.uri).toContain('next=passports');
    expect(help.buttons[2]?.uri).toBe(CITY_CONSULTATION_TEL_URI);
    expect(isLineHelpKind('fallback')).toBe(true);
  });

  it('sends eligibility questions to the official announcement, not a special LINE path', () => {
    const help = lineHelpPresentation('eligibility', LIFF_ID);
    expect(help.text).toContain('特定對象與一般申請走同一管道');
    expect(help.buttons[0]).toEqual({ label: '公告', uri: PROGRAM_ANNOUNCEMENT_URL });
  });

  it('refuses to confirm a disbursement date', () => {
    const help = lineHelpPresentation('disbursement_timing', LIFF_ID);
    expect(help.text).toContain('無法確認何時一定入帳');
    expect(help.text).not.toMatch(/工作天|保證/);
  });
});
