import { describe, expect, it } from 'vitest';
import {
  APPROVED_AI_TOOLS,
  APPROVED_AI_TOOL_CATEGORY_LABELS,
  APPROVED_AI_TOOL_OTHER_LABEL,
  approvedAiToolChoiceOptions,
  filterAllowedChoiceLabels,
  isBlockedAiToolLabel,
  isOtherChoiceLabel,
  searchApprovedAiTools,
} from './approved-ai-tools';

describe('approved AI tools', () => {
  it('includes categorized curated tools', () => {
    expect(APPROVED_AI_TOOLS).toHaveLength(69);
    expect(new Set(APPROVED_AI_TOOLS.map((tool) => tool.category)).size).toBe(
      Object.keys(APPROVED_AI_TOOL_CATEGORY_LABELS).length,
    );
    expect(APPROVED_AI_TOOLS.some((tool) => tool.label === 'Cursor')).toBe(true);
    expect(APPROVED_AI_TOOLS.some((tool) => tool.label === 'Grok')).toBe(true);
    expect(APPROVED_AI_TOOLS.some((tool) => /Stability/i.test(tool.label))).toBe(false);
  });

  it('searches by label, company, or category', () => {
    expect(searchApprovedAiTools('open').map((tool) => tool.label)).toEqual(
      expect.arrayContaining(['ChatGPT', 'Codex', 'Sora']),
    );
    expect(searchApprovedAiTools('影音').every((tool) => tool.category === 'av')).toBe(true);
  });

  it('builds grouped choice options ending with other', () => {
    const options = approvedAiToolChoiceOptions();
    expect(options).toHaveLength(70);
    expect(options.at(-1)).toMatchObject({ value: '__other__', group: '其他' });
    expect(options[0]?.group).toBe(APPROVED_AI_TOOL_CATEGORY_LABELS.chat_search);
  });

  it('blocks PRC / HK / Macau AI labels and keeps common western tools', () => {
    expect(isBlockedAiToolLabel('DeepSeek')).toBe(true);
    expect(isBlockedAiToolLabel('通义千问')).toBe(true);
    expect(isBlockedAiToolLabel('文心一言')).toBe(true);
    expect(isBlockedAiToolLabel('ChatGPT')).toBe(false);
    expect(isBlockedAiToolLabel('Claude')).toBe(false);
  });

  it('blocks traditional-character vendor names, which is what a Taiwanese receipt prints', () => {
    for (const label of ['騰訊混元', '通義千問', '阿里雲', '訊飛星火', '零一萬物', '華為盤古', '字節跳動']) {
      expect(isBlockedAiToolLabel(label)).toBe(true);
    }
  });

  it('blocks the vendor on the receipt that started this rule', () => {
    expect(isBlockedAiToolLabel('Alibaba Cloud (Singapore) Private Limited')).toBe(true);
  });

  it('blocks relay shops, shared-quota resale and token packages', () => {
    for (const label of ['Token Plan Individual', 'OpenAI API 中轉站', 'ChatGPT 拼車', '代充 Claude Pro', 'api2d']) {
      expect(isBlockedAiToolLabel(label)).toBe(true);
    }
  });

  it('leaves ordinary western purchases alone', () => {
    for (const label of ['ChatGPT Plus', 'Claude Pro', 'Cursor', 'Notion AI', 'Adobe Firefly', 'GitHub Copilot']) {
      expect(isBlockedAiToolLabel(label)).toBe(false);
    }
  });

  it('judges against the list it is given, so a program own denylist governs', () => {
    expect(isBlockedAiToolLabel('DeepSeek', [])).toBe(false);
    expect(isBlockedAiToolLabel('Example Vendor', ['example vendor'])).toBe(true);
  });

  it('filters blocked choices and recognizes the other option', () => {
    expect(filterAllowedChoiceLabels(['ChatGPT', 'DeepSeek', 'Kimi'])).toEqual(['ChatGPT']);
    expect(isOtherChoiceLabel(APPROVED_AI_TOOL_OTHER_LABEL)).toBe(true);
    expect(isOtherChoiceLabel('其他')).toBe(true);
  });
});
