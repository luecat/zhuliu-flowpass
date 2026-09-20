export type LineIntent =
  | { kind: 'faq'; answer: string }
  | { kind: 'subsidy_policy' }
  | { kind: 'case_status' }
  | { kind: 'subsidy_amount' }
  | { kind: 'tool_status'; tool: string }
  | { kind: 'eligibility' }
  | { kind: 'contact_city' }
  | { kind: 'disbursement_timing' }
  | { kind: 'fallback' };

export type LineHelpKind = 'fallback' | 'eligibility' | 'contact_city' | 'disbursement_timing';

export type LineReplyButton = {
  label: string;
  uri: string;
};

export type LineHelpPresentation = {
  title: string;
  text: string;
  buttons: LineReplyButton[];
};

/** 新竹市青年發展中心「AI領航青年數位工具補助」公告頁，資格以該頁為準。 */
export const PROGRAM_ANNOUNCEMENT_URL =
  'https://youthhsinchu.hccg.gov.tw/youth/app/artwebsite?id=64&module=artwebsite&serno=null';

export const CITY_CONSULTATION_PHONE = '03-522-0557';
export const CITY_CONSULTATION_TEL_URI = 'tel:+88635220557';
export const YOUTH_CENTER_PHONE = '03-5678138#9';
export const YOUTH_CENTER_ADDRESS = '新竹市東區龍山西路99號4樓';

// `answer: null` marks topics whose reply must be built from live data instead of fixed copy.
const FAQ: Array<{ title: string; patterns: RegExp[]; answer: string | null }> = [
  {
    title: '這是什麼',
    patterns: [/這是什麼/, /FlowPass 是什麼/, /竹流是什麼/, /什麼是 FlowPass/, /這個怎麼用/, /給誰用/],
    answer: '竹流 FlowPass 給已購買核准 AI 工具、準備申請補助的新竹市青年使用。\n你在 LINE 描述資料怎麼用、確認一份「資料護照」（資料從哪裡來、交給哪個工具、存在哪裡、誰會看到），再上傳身分證正反面、官方收據、刷卡單筆明細、存摺封面與切結書後送出。\nAI 只協助整理流向，不決定能不能補助、也不決定金額。審核與撥款由市府辦理；LINE 可查進度、補件與工具檢測。資格請看市府公告。',
  },
  {
    title: '怎麼申請',
    patterns: [/怎麼申請/, /如何申請/, /開始申請/, /要準備什麼/, /需要什麼文件/, /準備哪些/],
    answer: '申請流程只需 3 步驟：\n1. 填寫概況：描述欲處理的資料類型、AI 用途與分享對象。\n2. 確認護照：確認 AI 生成的資料流程與安全注意事項。\n3. 上傳憑證：填寫購買資料，並上傳身分證正反面、官方收據、刷卡單筆明細、存摺封面與切結書。代付另需代付切結書；低收／中低收入戶另需資格證明。\n\n請直接由 LINE 下方選單點選「申請」即可開始！',
  },
  {
    title: '護照是什麼',
    patterns: [/護照是什麼/, /什麼是護照/, /資料流向/, /AI 護照/, /FlowPass 護照/],
    answer: '「AI 資料護照」是為您這筆申請建立的資料使用與安全履歷。\n它記錄了您使用的資料類型、委託處理的 AI 工具、存放位置與分享對象。送出後系統會依護照內容主動比對公開資安事件，為您的資料安全把關。您可隨時由選單「進度查詢」檢視已確認的護照與專屬安全卡。',
  },
  {
    title: '補助多少',
    patterns: [/補助多少/, /可以領多少/, /補助上限/, /補助比例/, /補助金額/],
    answer: null,
  },
  {
    title: '撥款與入帳',
    patterns: [/撥款/, /列入撥款/, /撥款通知/, /匯入存摺/],
    answer: '案件審核通過並列入撥款排程後，款項將匯入您上傳之存摺帳戶，系統亦會主動發送 LINE 推播通知。\n入帳確切日期屬市府核銷流程，FlowPass 無法確認。您可點選選單「進度查詢」確認最新核定與撥款狀態。',
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

const CITY_CONTACT_WHEN_STUCK = [
  'LINE 僅供線上查詢進度，資格與承辦請洽市府窗口。',
  `諮詢專線 ${CITY_CONSULTATION_PHONE}（請於市府上班時間撥打）`,
  `青年發展中心 ${YOUTH_CENTER_PHONE}`,
  YOUTH_CENTER_ADDRESS,
].join('\n');

function announcementButton(): LineReplyButton {
  return { label: '公告', uri: PROGRAM_ANNOUNCEMENT_URL };
}

function progressButton(liffId: string): LineReplyButton {
  return { label: '進度查詢', uri: `https://liff.line.me/${encodeURIComponent(liffId)}/?next=passports` };
}

function consultButton(): LineReplyButton {
  return { label: '諮詢專線', uri: CITY_CONSULTATION_TEL_URI };
}

export function lineHelpPresentation(kind: LineHelpKind, liffId: string): LineHelpPresentation {
  switch (kind) {
    case 'fallback':
      return {
        title: '請改問關鍵字',
        text: [
          '這題超出 FlowPass 可自動回答的範圍。請改問下列關鍵字，或查官方公告、聯絡市府承辦。',
          '',
          FAQ_OVERVIEW,
          '',
          CITY_CONTACT_WHEN_STUCK,
        ].join('\n'),
        buttons: [announcementButton(), progressButton(liffId), consultButton()],
      };
    case 'eligibility':
      return {
        title: '申請資格',
        text: '申請資格以市府公告為準。特定對象與一般申請走同一管道；LINE 可查進度。請點「公告」查看資格。',
        buttons: [announcementButton(), progressButton(liffId)],
      };
    case 'contact_city':
      return {
        title: '市府窗口',
        text: CITY_CONTACT_WHEN_STUCK,
        buttons: [announcementButton(), consultButton()],
      };
    case 'disbursement_timing':
      return {
        title: '入帳時程無法確認',
        text: [
          '入帳時程屬市府核銷流程，FlowPass 無法確認何時一定入帳。審核通過後會以 LINE 通知狀態。',
          '',
          CITY_CONTACT_WHEN_STUCK,
        ].join('\n'),
        buttons: [announcementButton(), progressButton(liffId)],
      };
    default: {
      const unexpected: never = kind;
      throw new Error(`Unhandled LINE help kind: ${unexpected}`);
    }
  }
}

export function classifyLineIntent(text: string): LineIntent {
  const value = text.trim();
  if (!value) return { kind: 'fallback' };
  if (/^(常見問題|FAQ|幫助|help)$/i.test(value)) {
    return { kind: 'faq', answer: FAQ_OVERVIEW };
  }
  if (/我的案子|案子到哪|申請進度|目前狀態|進度查詢/.test(value)) return { kind: 'case_status' };
  if (/為什麼只核|為什麼是這個金額|為什麼是.?3000|核定金額|補助怎麼算/.test(value)) return { kind: 'subsidy_amount' };
  if (
    /何時一定|保證.{0,8}(入帳|撥款|匯款)|幾天.{0,8}(入帳|撥款|匯款)|什麼時候拿錢|何時入帳|何時匯款|何時發放|何時撥款|什麼時候.{0,8}(入帳|撥款|拿到錢)/.test(value)
  ) {
    return { kind: 'disbursement_timing' };
  }
  if (/資格|補助對象|誰可以申請|誰能申請|設籍|戶籍|幾歲|年齡限制|特定對象|文化語言|低收入|中低收入/.test(value)) {
    return { kind: 'eligibility' };
  }
  if (/聯絡|專線|窗口|市府電話|打給誰|客服|諮詢/.test(value)) {
    return { kind: 'contact_city' };
  }
  if (/^(檢測|護照檢測|工具檢測)$/.test(value) || /^(工具出事了嗎|有沒有出事)$/.test(value)) {
    return { kind: 'tool_status', tool: '' };
  }
  const toolMatch = value.match(/(?:工具出事|出事了嗎|有沒有出事)[:：\s]*(.+)$/i) ?? value.match(/^(.+?)(?:出事了嗎|有沒有出事)/);
  if (toolMatch?.[1]?.trim()) return { kind: 'tool_status', tool: toolMatch[1].trim().slice(0, 80) };
  for (const item of FAQ) {
    if (item.patterns.some((pattern) => pattern.test(value))) {
      return item.answer === null ? { kind: 'subsidy_policy' } : { kind: 'faq', answer: item.answer };
    }
  }
  return { kind: 'fallback' };
}

/** Subsidy figures come from the published rule so chat replies never disagree with the case calculation. */
export function subsidyPolicyReply(rule: { rateBps: number; capTwd: number } | null): string {
  if (!rule) {
    return '目前沒有開放中的補助方案。實際補助比例與上限以公開規則為準，開放申請後可再詢問「補助多少」。';
  }
  const rate = Number.isInteger(rule.rateBps / 100) ? String(rule.rateBps / 100) : (rule.rateBps / 100).toFixed(2);
  return `目前公開規則：補助合格購買金額的 ${rate}%，每案上限 NT$${rule.capTwd.toLocaleString('en-US')}。\n\n實際補助金額依公開規則試算與承辦人員審核為準。若已送件，亦可輸入「為什麼是這個金額」或由「進度查詢」查看金額試算說明。`;
}

export function lineFallbackReply(): string {
  return lineHelpPresentation('fallback', 'placeholder').text;
}

export function isLineHelpKind(kind: LineIntent['kind']): kind is LineHelpKind {
  switch (kind) {
    case 'fallback':
    case 'eligibility':
    case 'contact_city':
    case 'disbursement_timing':
      return true;
    case 'faq':
    case 'case_status':
    case 'subsidy_policy':
    case 'subsidy_amount':
    case 'tool_status':
      return false;
    default: {
      const unexpected: never = kind;
      throw new Error(`Unhandled LINE intent kind: ${unexpected}`);
    }
  }
}
