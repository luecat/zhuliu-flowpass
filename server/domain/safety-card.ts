import type { FlowPassPassport } from '../../shared/passport-contract';

export type SafetyCardModel = {
  title: string;
  purpose: string;
  flow: string[];
  beforeUpload: string[];
  whileUsing: string[];
  beforePublish: string[];
  incidentSteps: Array<{ key: string; action: string }>;
  meta: { tool: string; audience: string; retention: string };
};

type PassportNodeKind = FlowPassPassport['nodes'][number]['kind'];

/** Same reading order as the applicant flow view; one line per stage instead of edge pairs. */
const FLOW_STAGES: Array<[string, PassportNodeKind[]]> = [
  ['用到的資料', ['data']],
  ['交給 AI 處理', ['ai_tool', 'plugin']],
  ['存放位置', ['storage']],
  ['分享與發布', ['destination', 'organization', 'person']],
];

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function buildSafetyCardModel(passport: FlowPassPassport): SafetyCardModel {
  const tools = passport.nodes.filter((node) => node.kind === 'ai_tool' || node.kind === 'plugin').map((node) => node.label);
  const flow = FLOW_STAGES
    .map(([title, kinds]) => {
      const labels = unique(passport.nodes.filter((node) => kinds.includes(node.kind)).map((node) => node.label));
      return labels.length > 0 ? `${title}：${labels.join('、')}` : null;
    })
    .filter((line): line is string => line !== null);

  const safety = passport.safety_actions.map((item) => item.action).slice(0, 6);
  const beforeUpload = unique([
    ...safety.filter((item) => /同意|去識別|遮蔽|移除|授權/.test(item)),
    '取得照片、肖像、錄音與公開發布的同意',
    '絕不上傳密碼、API 金鑰、金融資料與組織機密',
  ]).slice(0, 5);
  const whileUsing = unique([
    ...safety.filter((item) => /權限|雲端|外掛|多因素|檢查/.test(item)),
    '外掛只開啟完成任務所需的最低權限',
    '雲端資料夾限定成員，不使用公開連結',
  ]).slice(0, 5);
  const beforePublish = unique([
    ...safety.filter((item) => /公開|發布|刪除|撤銷/.test(item)),
    '再次確認肖像、聲音與素材的公開授權範圍',
    '依情境揭露 AI 參與程度，避免誤導',
  ]).slice(0, 4);

  return {
    title: passport.use_case.title,
    purpose: passport.use_case.purpose,
    flow,
    beforeUpload,
    whileUsing,
    beforePublish,
    incidentSteps: [
      { key: '停', action: '停止上傳、生成與分享' },
      { key: '隔', action: '撤銷外掛或雲端權限，必要時更換密碼與金鑰' },
      { key: '留', action: '保留事件時間、工具、帳號與操作紀錄' },
      { key: '報', action: '通知服務提供者、市府或資安窗口' },
      { key: '查', action: '確認用過哪些資料、分享給誰，是否需通知相關人員' },
    ],
    meta: {
      tool: tools[0] ?? passport.administrative_hints.requested_tool,
      audience: passport.sharing_scope.audience,
      retention: !passport.retention.duration || passport.retention.duration === 'unknown' ? '尚未詢問' : passport.retention.duration,
    },
  };
}

export function renderSafetyCardSvg(model: SafetyCardModel): string {
  const escape = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const flowLines = model.flow.map((item, index) => (
    `<text x="48" y="${232 + index * 32}" font-size="18" fill="#1f2f28">${index + 1}. ${escape(item)}</text>`
  )).join('');
  const before = model.beforeUpload.map((item, index) => (
    `<text x="48" y="${430 + index * 24}" font-size="15" fill="#31443a">• ${escape(item)}</text>`
  )).join('');
  const during = model.whileUsing.map((item, index) => (
    `<text x="620" y="${430 + index * 24}" font-size="15" fill="#31443a">• ${escape(item)}</text>`
  )).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#edf6f0"/>
      <stop offset="100%" stop-color="#d7ebe0"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)"/>
  <rect x="28" y="28" width="1144" height="619" rx="28" fill="#ffffff" fill-opacity="0.88"/>
  <text x="56" y="78" font-size="18" font-weight="700" fill="#3f6b55">FLOWPASS · AI 安全使用懶人包</text>
  <text x="56" y="118" font-size="34" font-weight="800" fill="#163529">${escape(model.title)}</text>
  <text x="56" y="150" font-size="16" fill="#5b6f65">${escape(model.purpose)}</text>
  <text x="48" y="198" font-size="18" font-weight="700" fill="#215d3e">你的資料流向</text>
  ${flowLines}
  <text x="48" y="404" font-size="18" font-weight="700" fill="#215d3e">上傳前必做</text>
  ${before}
  <text x="620" y="404" font-size="18" font-weight="700" fill="#215d3e">使用中必做</text>
  ${during}
  <text x="48" y="600" font-size="14" fill="#6a7871">工具：${escape(model.meta.tool)} · 分享：${escape(model.meta.audience)} · 保存：${escape(model.meta.retention)}</text>
  <text x="48" y="628" font-size="14" fill="#6a7871">異常時：停、隔、留、報、查</text>
</svg>`;
}
