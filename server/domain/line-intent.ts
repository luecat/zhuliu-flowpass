export type LineIntent =
  | { kind: 'faq'; answer: string }
  | { kind: 'case_status' }
  | { kind: 'subsidy_amount' }
  | { kind: 'tool_status'; tool: string }
  | { kind: 'fallback' };

const FAQ: Array<{ patterns: RegExp[]; answer: string }> = [
  {
    patterns: [/怎麼申請/, /如何申請/, /要準備什麼/, /需要什麼文件/],
    answer: '請從 LINE 選單開啟 FlowPass 申請頁，先描述你想完成的事，再完成護照確認、購買資料與附件上傳。必要文件通常包含身分證正反面、購買證明與存摺封面。',
  },
  {
    patterns: [/補助多少/, /可以領多少/, /補助上限/, /補助比例/],
    answer: '一般青年為合格購買金額的 50%，上限 3,000 元；低收／中低收入戶為 90%，上限 6,000 元。實際核定以規則試算與承辦審核為準。',
  },
  {
    patterns: [/撥款/, /何時入帳/, /什麼時候拿錢/],
    answer: '案件核准並列入撥款後，系統會主動推播進度。你也可以在申請紀錄查看目前狀態，無需反覆詢問。',
  },
];

export function classifyLineIntent(text: string): LineIntent {
  const value = text.trim();
  if (!value) return { kind: 'fallback' };
  if (/^(常見問題|FAQ)$/i.test(value)) {
    return {
      kind: 'faq',
      answer: FAQ.map((item, index) => `${index + 1}. ${item.answer}`).join('\n\n'),
    };
  }
  if (/我的案子|案子到哪|申請進度|目前狀態|進度查詢/.test(value)) return { kind: 'case_status' };
  if (/為什麼只核|為什麼是這個金額|為什麼是.?3000|核定金額|補助怎麼算/.test(value)) return { kind: 'subsidy_amount' };
  if (/^(檢測|護照檢測|工具檢測)$/.test(value) || /^(工具出事了嗎|有沒有出事)$/.test(value)) {
    return { kind: 'tool_status', tool: '' };
  }
  const toolMatch = value.match(/(?:工具出事|出事了嗎|有沒有出事)[:：\s]*(.+)$/i) ?? value.match(/^(.+?)(?:出事了嗎|有沒有出事)/);
  if (toolMatch?.[1]?.trim()) return { kind: 'tool_status', tool: toolMatch[1].trim().slice(0, 80) };
  for (const item of FAQ) {
    if (item.patterns.some((pattern) => pattern.test(value))) return { kind: 'faq', answer: item.answer };
  }
  return { kind: 'fallback' };
}
