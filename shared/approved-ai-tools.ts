/** Curated AI tools allowed for FlowPass subsidy selection. Excludes PRC / HK / Macau products. */

import { containsBlockedTerm } from './blocked-terms';
import { DEFAULT_BLOCKED_VENDORS } from './default-blocked-vendors';

export type ApprovedAiToolCategory =
  | 'chat_search'
  | 'coding'
  | 'image'
  | 'av'
  | 'design_present'
  | 'writing_productivity'
  | 'automation_schedule'
  | 'social_character';

export type ApprovedAiTool = {
  id: string;
  label: string;
  company: string;
  category: ApprovedAiToolCategory;
};

export const APPROVED_AI_TOOL_CATEGORY_LABELS: Record<ApprovedAiToolCategory, string> = {
  chat_search: '對話與搜尋',
  coding: '程式開發',
  image: '影像生成',
  av: '影音生成',
  design_present: '設計與簡報',
  writing_productivity: '文書與生產力',
  automation_schedule: '自動化與排程',
  social_character: '社群與角色',
};

export const APPROVED_AI_TOOLS: readonly ApprovedAiTool[] = [
  // 對話與搜尋
  { id: 'chatgpt', label: 'ChatGPT', company: 'OpenAI', category: 'chat_search' },
  { id: 'claude', label: 'Claude', company: 'Anthropic', category: 'chat_search' },
  { id: 'gemini', label: 'Gemini', company: 'Google', category: 'chat_search' },
  { id: 'copilot', label: 'Microsoft Copilot', company: 'Microsoft', category: 'chat_search' },
  { id: 'grok', label: 'Grok', company: 'xAI', category: 'chat_search' },
  { id: 'meta-ai', label: 'Meta AI', company: 'Meta', category: 'chat_search' },
  { id: 'perplexity', label: 'Perplexity', company: 'Perplexity', category: 'chat_search' },
  { id: 'notebooklm', label: 'NotebookLM', company: 'Google', category: 'chat_search' },
  { id: 'elicit', label: 'Elicit', company: 'Elicit', category: 'chat_search' },
  { id: 'consensus', label: 'Consensus', company: 'Consensus', category: 'chat_search' },
  { id: 'you-com', label: 'You.com', company: 'You.com', category: 'chat_search' },
  { id: 'chatpdf', label: 'ChatPDF', company: 'ChatPDF', category: 'chat_search' },
  // 程式開發
  { id: 'cursor', label: 'Cursor', company: 'Anysphere', category: 'coding' },
  { id: 'github-copilot', label: 'GitHub Copilot', company: 'GitHub / Microsoft', category: 'coding' },
  { id: 'claude-code', label: 'Claude Code', company: 'Anthropic', category: 'coding' },
  { id: 'codex', label: 'Codex', company: 'OpenAI', category: 'coding' },
  { id: 'gemini-code-assist', label: 'Gemini Code Assist', company: 'Google', category: 'coding' },
  { id: 'windsurf', label: 'Windsurf', company: 'Windsurf', category: 'coding' },
  { id: 'replit', label: 'Replit', company: 'Replit', category: 'coding' },
  { id: 'lovable', label: 'Lovable', company: 'Lovable', category: 'coding' },
  { id: 'bolt-new', label: 'Bolt.new', company: 'StackBlitz', category: 'coding' },
  { id: 'v0', label: 'v0', company: 'Vercel', category: 'coding' },
  { id: 'devin', label: 'Devin', company: 'Cognition', category: 'coding' },
  // 影像生成
  { id: 'midjourney', label: 'Midjourney', company: 'Midjourney', category: 'image' },
  { id: 'adobe-firefly', label: 'Adobe Firefly', company: 'Adobe', category: 'image' },
  { id: 'canva', label: 'Canva AI', company: 'Canva', category: 'image' },
  { id: 'leonardo-ai', label: 'Leonardo AI', company: 'Leonardo.Ai', category: 'image' },
  { id: 'ideogram', label: 'Ideogram', company: 'Ideogram', category: 'image' },
  { id: 'recraft', label: 'Recraft', company: 'Recraft', category: 'image' },
  // 影音生成
  { id: 'sora', label: 'Sora', company: 'OpenAI', category: 'av' },
  { id: 'google-veo', label: 'Google Veo', company: 'Google', category: 'av' },
  { id: 'runway', label: 'Runway', company: 'Runway', category: 'av' },
  { id: 'pika', label: 'Pika', company: 'Pika', category: 'av' },
  { id: 'luma', label: 'Luma', company: 'Luma AI', category: 'av' },
  { id: 'heygen', label: 'HeyGen', company: 'HeyGen', category: 'av' },
  { id: 'synthesia', label: 'Synthesia', company: 'Synthesia', category: 'av' },
  { id: 'elevenlabs', label: 'ElevenLabs', company: 'ElevenLabs', category: 'av' },
  { id: 'adobe-podcast', label: 'Adobe Podcast', company: 'Adobe', category: 'av' },
  { id: 'descript', label: 'Descript', company: 'Descript', category: 'av' },
  { id: 'suno', label: 'Suno', company: 'Suno', category: 'av' },
  { id: 'udio', label: 'Udio', company: 'Udio', category: 'av' },
  // 設計與簡報
  { id: 'figma-ai', label: 'Figma AI', company: 'Figma', category: 'design_present' },
  { id: 'framer-ai', label: 'Framer AI', company: 'Framer', category: 'design_present' },
  { id: 'uizard', label: 'Uizard', company: 'Uizard', category: 'design_present' },
  { id: 'gamma', label: 'Gamma', company: 'Gamma', category: 'design_present' },
  { id: 'beautiful-ai', label: 'Beautiful.ai', company: 'Beautiful.ai', category: 'design_present' },
  { id: 'napkin-ai', label: 'Napkin AI', company: 'Napkin', category: 'design_present' },
  // 文書與生產力
  { id: 'notion-ai', label: 'Notion AI', company: 'Notion', category: 'writing_productivity' },
  { id: 'grammarly', label: 'Grammarly', company: 'Grammarly', category: 'writing_productivity' },
  { id: 'jasper', label: 'Jasper', company: 'Jasper', category: 'writing_productivity' },
  { id: 'wordtune', label: 'Wordtune', company: 'Wordtune', category: 'writing_productivity' },
  { id: 'otter-ai', label: 'Otter.ai', company: 'Otter', category: 'writing_productivity' },
  { id: 'fireflies-ai', label: 'Fireflies.ai', company: 'Fireflies', category: 'writing_productivity' },
  { id: 'tldv', label: 'tl;dv', company: 'tl;dv', category: 'writing_productivity' },
  { id: 'zoom-ai-companion', label: 'Zoom AI Companion', company: 'Zoom', category: 'writing_productivity' },
  // 自動化與排程
  { id: 'zapier', label: 'Zapier', company: 'Zapier', category: 'automation_schedule' },
  { id: 'make', label: 'Make', company: 'Make', category: 'automation_schedule' },
  { id: 'genspark', label: 'Genspark', company: 'Genspark', category: 'automation_schedule' },
  { id: 'manus', label: 'Manus', company: 'Manus', category: 'automation_schedule' },
  { id: 'motion', label: 'Motion', company: 'Motion', category: 'automation_schedule' },
  { id: 'reclaim', label: 'Reclaim', company: 'Reclaim', category: 'automation_schedule' },
  { id: 'shortwave', label: 'Shortwave', company: 'Shortwave', category: 'automation_schedule' },
  { id: 'superhuman', label: 'Superhuman', company: 'Superhuman', category: 'automation_schedule' },
  { id: 'mem', label: 'Mem', company: 'Mem', category: 'automation_schedule' },
  { id: 'tome', label: 'Tome', company: 'Tome', category: 'automation_schedule' },
  // 社群與角色
  { id: 'buffer', label: 'Buffer', company: 'Buffer', category: 'social_character' },
  { id: 'feedhive', label: 'FeedHive', company: 'FeedHive', category: 'social_character' },
  { id: 'character-ai', label: 'Character.AI', company: 'Character Technologies', category: 'social_character' },
  { id: 'pi', label: 'Pi', company: 'Inflection AI', category: 'social_character' },
] as const;

export const APPROVED_AI_TOOL_OTHER_LABEL = '其他（自行填寫）';

function normalizeToken(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

export function findApprovedAiTool(value: string): ApprovedAiTool | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) return undefined;
  return APPROVED_AI_TOOLS.find(
    (tool) => normalizeToken(tool.label) === normalized || normalizeToken(tool.id) === normalized,
  );
}

export function searchApprovedAiTools(query: string): ApprovedAiTool[] {
  const normalized = normalizeToken(query);
  if (!normalized) return [...APPROVED_AI_TOOLS];
  return APPROVED_AI_TOOLS.filter((tool) => {
    const haystack = `${tool.label} ${tool.company} ${tool.id} ${APPROVED_AI_TOOL_CATEGORY_LABELS[tool.category]}`;
    return normalizeToken(haystack).includes(normalized);
  });
}

export function approvedAiToolChoiceOptions(): Array<{
  value: string;
  label: string;
  hint: string;
  group: string;
}> {
  return [
    ...APPROVED_AI_TOOLS.map((tool) => ({
      value: tool.id,
      label: tool.label,
      hint: tool.company,
      group: APPROVED_AI_TOOL_CATEGORY_LABELS[tool.category],
    })),
    { value: '__other__', label: APPROVED_AI_TOOL_OTHER_LABEL, hint: '', group: '其他' },
  ];
}

/**
 * Screening delegates to the denylist: the terms live in
 * default-blocked-vendors.ts (and, once seeded, in the program's own
 * softwareBlacklist), and matching lives in blocked-terms.ts. Callers that
 * know which program cycle they are serving pass that cycle's stored list;
 * the rest fall back to the shipped seed.
 */
export function isBlockedAiToolLabel(value: string, terms: readonly string[] = DEFAULT_BLOCKED_VENDORS): boolean {
  return containsBlockedTerm(value, terms);
}

export function filterAllowedChoiceLabels(choices: string[], terms?: readonly string[]): string[] {
  return choices.filter((choice) => !isBlockedAiToolLabel(choice, terms));
}

export function isOtherChoiceLabel(value: string): boolean {
  const text = value.normalize('NFKC').trim();
  return /^(其他|其它|other)(?:\s*[（(].*[）)])?$/i.test(text) || text === APPROVED_AI_TOOL_OTHER_LABEL;
}
