export type LineIntent =
  | { kind: 'faq'; answer: string }
  | { kind: 'case_status' }
  | { kind: 'subsidy_amount' }
  | { kind: 'tool_status'; tool: string }
  | { kind: 'fallback' };

/** Shared canned replies only — this official account cannot send personalized chat replies. */
const FAQ: Array<{ title: string; patterns: RegExp[]; answer: string }> = [
  {
    title: '怎麼申請',
    patterns: [/怎麼申請/, /如何申請/, /開始申請/, /要準備什麼/, /需要什麼文件/, /準備哪些/],
    answer: '請從 LINE 選單開啟「申請」。先描述你想完成的事，再完成護照確認、購買資料與附件上傳。通常需要身分證正反面、購買證明與存摺封面。',
  },
  {
    title: '護照是什麼',
    patterns: [/護照是什麼/, /什麼是護照/, /資料流向/, /AI 護照/, /FlowPass 護照/],
    answer: '護照是你這次申請確認過的 AI 使用說明：用了哪些資料、交給哪些工具、分享給誰。送出後會用來比對公開資安事件，也可在申請紀錄查看。',
  },
  {
    title: '補助多少',
    patterns: [/補助多少/, /可以領多少/, /補助上限/, /補助比例/, /補助怎麼算/, /補助金額/],
    answer: '一般青年為合格購買金額的 50%，上限 3,000 元；低收／中低收入戶為 90%，上限 6,000 元。實際核定以規則試算與承辦審核為準。個人案件金額請開選單「進度查詢」。',
  },
  {
    title: '撥款與入帳',
    patterns: [/撥款/, /何時入帳/, /什麼時候拿錢/, /何時匯款/, /何時發放/],
    answer: '案件核准並列入撥款後會推播通知。個人入帳進度請開選單「進度查詢」，聊天室無法查詢個別案件。',
  },
  {
    title: '進度與補件',
    patterns: [/補件/, /修正/, /退回/, /要補什麼/, /怎麼補/],
    answer: '若需補件或修正，請開選單「進度查詢」依頁面指示上傳或修改。聊天室無法代查或代改個別案件。',
  },
  {
    title: '工具檢測',
    patterns: [/檢測/, /資安事件/, /公開事件/, /工具出事/, /有沒有出事/, /安全檢測/],
    answer: '公開資安事件所有人都能在選單「檢測」查看。若事件與你的護照有關，同一頁會另有「專屬提醒」。聊天室只提供共用說明，不提供個人化回覆。',
  },
];

const FAQ_OVERVIEW = [
  '竹流 FlowPass 常見問題（本帳號僅提供共用說明，無法個別回覆案件）：',
  ...FAQ.map((item, index) => `${index + 1}. ${item.title}`),
  '',
  '可直接輸入關鍵字，例如：怎麼申請、護照是什麼、補助多少、撥款、補件、檢測。',
  '個人進度、金額與專屬資安提醒，請用下方選單開啟對應頁面。',
].join('\n');

const FALLBACK = [
  '本帳號無法個別回覆案件內容。',
  '共用說明可輸入：怎麼申請、護照是什麼、補助多少、撥款、補件、檢測。',
  '或開啟選單：申請／檢測／進度查詢／FAQ。',
].join('\n');

export function classifyLineIntent(text: string): LineIntent {
  const value = text.trim();
  if (!value) return { kind: 'fallback' };
  if (/^(常見問題|FAQ|選單|幫助|help)$/i.test(value)) {
    return { kind: 'faq', answer: FAQ_OVERVIEW };
  }
  // Keep intent kinds for routing, but replies stay generic (no per-user content in chat).
  if (/我的案子|案子到哪|申請進度|目前狀態|進度查詢/.test(value)) return { kind: 'case_status' };
  if (/為什麼只核|為什麼是這個金額|為什麼是.?3000|核定金額/.test(value)) return { kind: 'subsidy_amount' };
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

export function lineFallbackReply(): string {
  return FALLBACK;
}

export function lineMenuRedirectReply(kind: 'case_status' | 'subsidy_amount'): string {
  if (kind === 'subsidy_amount') {
    return '補助規則：一般青年 50%、上限 3,000 元；低收／中低收入戶 90%、上限 6,000 元。\n個人案件金額與試算說明，請開選單「進度查詢」。本帳號無法個別回覆。';
  }
  return '個人申請進度請開選單「進度查詢」。本帳號無法個別查詢或回覆案件狀態。';
}
