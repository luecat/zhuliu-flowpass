export type LineIntent =
  | { kind: 'faq'; answer: string }
  | { kind: 'case_status' }
  | { kind: 'subsidy_amount' }
  | { kind: 'tool_status'; tool: string }
  | { kind: 'fallback' };

const FAQ: Array<{ title: string; patterns: RegExp[]; answer: string }> = [
  {
    title: '怎麼申請',
    patterns: [/怎麼申請/, /如何申請/, /開始申請/, /要準備什麼/, /需要什麼文件/, /準備哪些/],
    answer: '申請流程只需 3 步驟：\n1. 填寫概況：描述欲處理的資料類型、AI 用途與分享對象。\n2. 確認護照：確認 AI 生成的資料流程與安全注意事項。\n3. 上傳憑證：填寫購買資料，並上傳身分證正反面、購買發票與存摺封面。\n\n請直接由 LINE 下方選單點選「申請」即可開始！',
  },
  {
    title: '護照是什麼',
    patterns: [/護照是什麼/, /什麼是護照/, /資料流向/, /AI 護照/, /FlowPass 護照/],
    answer: '「AI 資料護照」是為您這筆申請建立的資料使用與安全履歷。\n它記錄了您使用的資料類型、委託處理的 AI 工具、存放位置與分享對象。送出後系統會依護照內容主動比對公開資安事件，為您的資料安全把關。您可隨時由選單「進度查詢」檢視已確認的護照與專屬安全卡。',
  },
  {
    title: '補助多少',
    patterns: [/補助多少/, /可以領多少/, /補助上限/, /補助比例/, /補助金額/],
    answer: '青年 AI 工具補助標準如下：\n• 一般青年：補助合格購買金額的 50%，上限 3,000 元。\n• 特定對象（如低收／中低收入戶等）：補助合格金額的 90%，上限 6,000 元。\n\n實際補助金額依公開規則試算與承辦人員審核為準。若已送件，亦可輸入「為什麼是這個金額」或由「進度查詢」查看金額試算說明。',
  },
  {
    title: '撥款與入帳',
    patterns: [/撥款/, /何時入帳/, /什麼時候拿錢/, /何時匯款/, /何時發放/],
    answer: '案件審核通過並列入撥款排程後，款項將匯入您上傳之存摺帳戶，系統亦會主動發送 LINE 推播通知。\n您也可以隨時點選選單「進度查詢」確認最新的核定金額與撥款進度。',
  },
  {
    title: '進度與補件',
    patterns: [/補件/, /修正/, /退回/, /要補什麼/, /怎麼補/],
    answer: '若案件需要「補充文件」或「修改內容」：\n請開啟選單「進度查詢」，進入案件詳情後即可查看承辦人員說明的具體項目與期限，並直接在線上上傳文件或修改資料。\n您也可以在聊天室輸入「我的案子到哪了」快速查詢目前案件狀態。',
  },
  {
    title: '工具檢測',
    patterns: [/檢測說明/, /資安事件/, /公開事件/, /安全檢測是什麼/],
    answer: '點選選單「檢測」可查看主管機關與各大廠商公告的 AI 工具公開資安事件。\n若您已送出申請，系統會自動比對您護照中使用的工具；若有相關事件，將於檢測頁呈現「專屬提醒」與應對處置指引。亦可在聊天室輸入「檢測」取得最新通報摘要。',
  },
];

const FAQ_OVERVIEW = [
  '💡 竹流 FlowPass 常見問題：',
  ...FAQ.map((item, index) => `${index + 1}. ${item.title}（直接輸入「${item.title}」）`),
  '',
  '您也可以在聊天室直接詢問：',
  '👉 查詢進度：輸入「我的案子到哪了」',
  '👉 查詢金額：輸入「為什麼是這個金額」',
  '👉 工具安全：輸入「檢測」或「工具出事了嗎」',
  '',
  '或透過下方 LINE 圖文選單快速開啟：申請／檢測／進度查詢。',
].join('\n');

const FALLBACK = '竹流 FlowPass 能為您解答申請流程、補助金額與進度查詢相關問題。\n您可以輸入「常見問題」查看導覽，或試著詢問「怎麼申請」、「補助多少」、「我的案子到哪了」。\n亦可點擊下方 LINE 圖文選單直接操作。';

export function classifyLineIntent(text: string): LineIntent {
  const value = text.trim();
  if (!value) return { kind: 'fallback' };
  if (/^(常見問題|FAQ|幫助|help)$/i.test(value)) {
    return { kind: 'faq', answer: FAQ_OVERVIEW };
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

export function lineFallbackReply(): string {
  return FALLBACK;
}
