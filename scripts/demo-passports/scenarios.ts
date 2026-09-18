import { APPROVED_AI_TOOLS, type ApprovedAiToolCategory } from '../../shared/approved-ai-tools';
import { REFERENCE_FX_RATES_TWD } from '../../shared/fx-rates';
import type { PurchaseDetailsWrite } from '../../shared/purchase-details-contract';

/**
 * 100 synthetic subsidy cases for demos. Every name, card last-four and invoice
 * number here is fabricated. Order matters: fingerprint rules only match cases
 * submitted earlier, so the first case of a duplicate set passes and later ones
 * turn red.
 */

export const RULE_CODES = [
  'submission_window',
  'purchase_window',
  'invoice_fingerprint',
  'transaction_fingerprint',
  'payment_source_fingerprint',
  'exchange_rate_reasonableness',
  'tool_consistency',
  'subsidy_estimate',
] as const;

export type RuleCode = (typeof RULE_CODES)[number];
export type RuleOutcome = 'pass' | 'fail' | 'needs_review' | 'missing';
export type ScenarioFlow = 'submit' | 'blocked' | 'draft';

export const SCENARIO_GROUPS = {
  baseline: '基準乾淨案件',
  same_card: '卡號相同',
  same_invoice: '發票相同',
  same_date: '日期相同／交易重複',
  same_purchaser: '購買人相同',
  payer_mismatch: '刷卡人與購買人不同',
  ai_tools: '各種 AI 工具',
  edge: '其他邊界',
} as const;

export type ScenarioGroup = keyof typeof SCENARIO_GROUPS;

export interface DemoScenario {
  code: string;
  group: ScenarioGroup;
  title: string;
  reviewerNote: string;
  applicantKey: string;
  flow: ScenarioFlow;
  category: ApprovedAiToolCategory;
  passportTools: string[];
  plugin: string | null;
  purchase: PurchaseDetailsWrite;
  expect: Record<RuleCode, RuleOutcome>;
  expectReason: Partial<Record<RuleCode, string>>;
}

type Currency = PurchaseDetailsWrite['originalCurrency'];

interface ScenarioInput {
  group: ScenarioGroup;
  title: string;
  note: string;
  /** Approved tool id, or a free-text label for tools outside the curated list. */
  tool: string;
  company?: string;
  category?: ApprovedAiToolCategory;
  passportTools?: string[];
  plugin?: string;
  /** Same account key means the same LINE applicant account. */
  account?: string;
  name?: string;
  date?: string;
  currency?: Currency;
  otherCurrency?: string;
  expense?: string;
  converted?: number;
  monthlyPeriods?: number;
  payer?: 'self_card' | 'representative';
  card?: string;
  holder?: string;
  invoice?: string | null;
  special?: boolean;
  flow?: ScenarioFlow;
  flags?: Partial<Record<RuleCode, RuleOutcome>>;
  reasons?: Partial<Record<RuleCode, string>>;
}

const ALL_PASS: Record<RuleCode, RuleOutcome> = {
  submission_window: 'pass',
  purchase_window: 'pass',
  invoice_fingerprint: 'pass',
  transaction_fingerprint: 'pass',
  payment_source_fingerprint: 'pass',
  exchange_rate_reasonableness: 'pass',
  tool_consistency: 'pass',
  subsidy_estimate: 'pass',
};

const NAME_POOL = [
  '王柏翔', '李佳穎', '張家豪', '劉宜庭', '黃冠霖', '吳欣怡', '蔡承翰', '鄭雅筑', '謝明哲', '洪詩婷',
  '邱建宏', '曾郁婷', '廖彥廷', '賴思妤', '徐子軒', '周怡萱', '葉俊宏', '簡佩君', '潘宇翔', '方心妤',
  '施博凱', '翁若涵', '游政霖', '白雅琪', '呂孟哲', '何宛蓉', '高志偉', '林芷若', '柯立安', '姚品君',
];

const FUNCTION_BY_CATEGORY: Record<ApprovedAiToolCategory, PurchaseDetailsWrite['softwareFunction']> = {
  chat_search: 'general',
  coding: 'general',
  image: 'imaging',
  av: 'imaging',
  design_present: 'imaging',
  writing_productivity: 'office',
  automation_schedule: 'office',
  social_character: 'general',
};

const DEFAULT_EXPENSE: Record<Exclude<Currency, 'OTHER'>, (n: number) => string> = {
  TWD: (n) => String(500 + n * 13),
  USD: (n) => String(10 + n),
  JPY: (n) => String(1500 + n * 10),
  EUR: (n) => String(9 + n),
  AUD: (n) => String(15 + n),
  HKD: (n) => String(80 + n),
};

const baseline = (input: Omit<ScenarioInput, 'group' | 'title' | 'note'>): ScenarioInput => ({
  group: 'baseline',
  title: '乾淨案件（對照組）',
  note: '所有勾稽應為通過，用來對比紅燈案件。',
  ...input,
});
const group = (name: ScenarioGroup) => (input: Omit<ScenarioInput, 'group'>): ScenarioInput => ({ group: name, ...input });
const sameCard = group('same_card');
const sameInvoice = group('same_invoice');
const sameDate = group('same_date');
const samePurchaser = group('same_purchaser');
const payerMismatch = group('payer_mismatch');
const aiTools = group('ai_tools');
const edge = group('edge');

const RED_PAYMENT = { payment_source_fingerprint: 'needs_review' } as const;
const RED_INVOICE = { invoice_fingerprint: 'needs_review' } as const;
const RED_TRANSACTION = { transaction_fingerprint: 'needs_review' } as const;

const MIDJOURNEY_TX = { tool: 'midjourney', company: 'Midjourney Inc.', currency: 'USD', expense: '30', date: '2026-07-15' } as const;
const RUNWAY_TX = { tool: 'runway', currency: 'USD', expense: '35', date: '2026-06-10' } as const;
const COMPANY_CARD = '竹流科技有限公司';

const INPUTS: ScenarioInput[] = [
  // ── 基準乾淨案件 P001–P020：涵蓋 8 大類工具與 6 種幣別 ──
  baseline({ tool: 'chatgpt', currency: 'USD' }),
  baseline({ tool: 'claude', currency: 'USD', monthlyPeriods: 3 }),
  baseline({ tool: 'gemini' }),
  baseline({ tool: 'copilot' }),
  baseline({ tool: 'perplexity', currency: 'USD' }),
  baseline({ tool: 'cursor', currency: 'USD', monthlyPeriods: 6 }),
  baseline({ tool: 'github-copilot', currency: 'USD' }),
  baseline({ tool: 'claude-code', currency: 'USD' }),
  baseline({ tool: 'midjourney', currency: 'USD' }),
  baseline({ tool: 'adobe-firefly' }),
  baseline({ tool: 'canva' }),
  baseline({ tool: 'runway', currency: 'USD' }),
  baseline({ tool: 'elevenlabs', currency: 'EUR' }),
  baseline({ tool: 'suno', currency: 'USD', monthlyPeriods: 2 }),
  baseline({ tool: 'figma-ai', currency: 'JPY' }),
  baseline({ tool: 'gamma', currency: 'AUD' }),
  baseline({ tool: 'notion-ai', currency: 'HKD' }),
  baseline({ tool: 'grammarly', currency: 'USD' }),
  baseline({ tool: 'zapier', currency: 'EUR' }),
  baseline({ tool: 'character-ai', currency: 'USD' }),

  // ── 卡號相同 P021–P032 ──
  sameCard({ title: '家長卡代付：第一位子女', note: '同卡第一次出現，應通過；後續同卡案件會回指此案。', tool: 'chatgpt', currency: 'USD', name: '陳小安', payer: 'representative', card: '4821', holder: '陳志明', invoice: 'CM-48210001' }),
  sameCard({ title: '家長卡代付：第二位子女', note: '同末四碼＋同持卡人 → 付款來源紅燈；審核員判斷是否合法代付。', tool: 'canva', name: '陳小晴', payer: 'representative', card: '4821', holder: '陳志明', flags: RED_PAYMENT }),
  sameCard({ title: '家長卡代付：第三位子女', note: '同卡第三次出現，紅燈應列出前兩件案號。', tool: 'notion-ai', name: '陳小宇', payer: 'representative', card: '4821', holder: '陳志明', flags: RED_PAYMENT }),
  sameCard({ title: '本人卡第一次申請', note: '對照組，應通過。', tool: 'gemini', account: 'lin-yijun', name: '林怡君', card: '5566' }),
  sameCard({ title: '同一帳號同一張卡再申請', note: '同帳號、同卡、不同工具 → 付款來源紅燈。', tool: 'gamma', currency: 'AUD', account: 'lin-yijun', name: '林怡君', card: '5566', flags: RED_PAYMENT }),
  sameCard({ title: '英文持卡人姓名（標準寫法）', note: '對照組，應通過。', tool: 'perplexity', currency: 'USD', name: '王大明', card: '7788', holder: 'Wang Da Ming' }),
  sameCard({ title: '英文持卡人姓名大小寫與空白不同', note: '姓名正規化後相同 → 付款來源紅燈（驗證正規化）。', tool: 'grammarly', currency: 'USD', account: 'wang-daming-2', name: '王大明', card: '7788', holder: 'wang  da   ming', flags: RED_PAYMENT }),
  sameCard({ title: '末四碼 1234：持卡人 A', note: '對照組，應通過。', tool: 'heygen', currency: 'USD', name: '張雅婷', card: '1234' }),
  sameCard({ title: '末四碼 1234：持卡人 B', note: '末四碼相同但持卡人不同 → 設計上不視為同卡，應通過。', tool: 'descript', currency: 'USD', name: '黃俊傑', card: '1234' }),
  sameCard({ title: '末四碼 1234：持卡人 C', note: '同上；展示指紋是「末四碼＋姓名」組合，而非只看末四碼。', tool: 'luma', currency: 'USD', name: '吳佩珊', card: '1234' }),
  sameCard({ title: '同卡＋同發票（雙紅燈）', note: '沿用 P021 的卡與發票號碼 → 付款來源、發票指紋同時紅燈。', tool: 'chatgpt', currency: 'USD', expense: '66', name: '陳小芸', payer: 'representative', card: '4821', holder: '陳志明', invoice: 'CM-48210001', flags: { ...RED_PAYMENT, ...RED_INVOICE } }),
  sameCard({ title: '同持卡人不同卡', note: '持卡人同為陳志明但末四碼不同 → 不同付款來源，應通過。', tool: 'ideogram', currency: 'USD', name: '陳小凱', payer: 'representative', card: '9999', holder: '陳志明' }),

  // ── 發票相同 P033–P044 ──
  sameInvoice({ title: '發票第一次出現', note: '對照組，應通過；後續同發票案件會回指此案。', ...RUNWAY_TX, account: 'hsu-jingwen', name: '徐靖雯', card: '3301', invoice: 'QK-20260001' }),
  sameInvoice({ title: '他人使用完全相同發票號碼', note: '發票號碼完全一致 → 發票指紋紅燈。', tool: 'suno', currency: 'USD', name: '鍾宇恆', invoice: 'QK-20260001', flags: RED_INVOICE }),
  sameInvoice({ title: '發票號碼改小寫、去掉連字號', note: '正規化後相同 → 紅燈（防止改寫格式規避）。', tool: 'recraft', currency: 'USD', name: '馬郁雯', invoice: 'qk20260001', flags: RED_INVOICE }),
  sameInvoice({ title: '發票號碼插入空白', note: '正規化後相同 → 紅燈。', tool: 'pika', currency: 'USD', name: '董信宏', invoice: 'QK 2026 0001', flags: RED_INVOICE }),
  sameInvoice({ title: '發票號碼改全形字元', note: 'NFKC 正規化後相同 → 紅燈。', tool: 'synthesia', currency: 'USD', name: '姜欣妍', invoice: 'ＱＫ－２０２６０００１', flags: RED_INVOICE }),
  sameInvoice({ title: '相鄰發票號碼（末碼 +1）', note: '只差一碼 → 不視為重複，應通過。', tool: 'wordtune', name: '程柏宇', invoice: 'QK-20260002' }),
  sameInvoice({ title: '相似發票號碼（位數錯開）', note: '應通過。', tool: 'otter-ai', currency: 'USD', name: '田宜蓁', invoice: 'QK-20260010' }),
  sameInvoice({ title: '字軌不同、號碼相同', note: '應通過。', tool: 'fireflies-ai', currency: 'USD', name: '薛凱翔', invoice: 'QX-20260001' }),
  sameInvoice({ title: '未填發票號碼（一）', note: '發票指紋應為「待補」，由人工看附件。', tool: 'tldv', currency: 'USD', name: '余品妍', invoice: null, flags: { invoice_fingerprint: 'missing' }, reasons: { invoice_fingerprint: 'invoice_number_missing' } }),
  sameInvoice({ title: '未填發票號碼（二）', note: '兩件空白發票不會互相比中，仍為「待補」。', tool: 'zoom-ai-companion', name: '孔維哲', invoice: null, flags: { invoice_fingerprint: 'missing' } }),
  sameInvoice({ title: '同一人同一筆消費重複申請', note: '與 P033 完全相同（發票、卡、工具、金額、日期）→ 三個指紋同時紅燈。', ...RUNWAY_TX, account: 'hsu-jingwen', name: '徐靖雯', card: '3301', invoice: 'QK-20260001', flags: { ...RED_INVOICE, ...RED_TRANSACTION, ...RED_PAYMENT } }),
  sameInvoice({ title: '國外收據格式號碼', note: '非台灣發票格式，應通過。', tool: 'jasper', currency: 'USD', name: '羅婉如', invoice: 'INV-2026-0918-7731' }),

  // ── 日期相同／交易重複 P045–P056 ──
  sameDate({ title: '同日購買：工具 A', note: '同一天購買不同工具 → 日期本身不是重複訊號，應通過。', tool: 'claude', currency: 'USD', date: '2026-08-01', name: '陸冠宇' }),
  sameDate({ title: '同日購買：工具 B', note: '應通過。', tool: 'cursor', currency: 'USD', date: '2026-08-01', name: '葛芸熙' }),
  sameDate({ title: '同日購買：工具 C', note: '應通過。', tool: 'adobe-firefly', date: '2026-08-01', name: '聶宏毅' }),
  sameDate({ title: '同日購買：工具 D', note: '應通過。', tool: 'heygen', currency: 'USD', date: '2026-08-01', name: '管若琳' }),
  sameDate({ title: '同日購買：工具 E', note: '應通過。', tool: 'make', currency: 'EUR', date: '2026-08-01', name: '左家銘' }),
  sameDate({ title: '交易基準：Midjourney USD 30', note: '對照組，應通過。', ...MIDJOURNEY_TX, name: '韋志豪' }),
  sameDate({ title: '他人同工具同金額同日', note: '工具、供應商、幣別、金額、日期全同 → 交易指紋紅燈。', ...MIDJOURNEY_TX, name: '甘佳蓉', flags: RED_TRANSACTION }),
  sameDate({ title: '供應商名稱寫法不同', note: '「midjourney, inc」正規化後相同 → 交易指紋紅燈。', ...MIDJOURNEY_TX, company: 'midjourney, inc', name: '包立翔', flags: RED_TRANSACTION }),
  sameDate({ title: '金額寫成 30.00', note: '⚠ 漏洞示範：金額字串未正規化，30.00 與 30 不會比中，目前會通過。', ...MIDJOURNEY_TX, expense: '30.00', name: '車若瑜' }),
  sameDate({ title: '隔一天購買', note: '日期不同 → 應通過。', ...MIDJOURNEY_TX, date: '2026-07-16', name: '談思齊' }),
  sameDate({ title: '金額差 1 美元', note: '金額不同 → 應通過。', ...MIDJOURNEY_TX, expense: '31', name: '雷品睿' }),
  sameDate({ title: '同日同工具但日圓計價', note: '幣別不同 → 應通過。', ...MIDJOURNEY_TX, currency: 'JPY', expense: '4500', name: '龍詠晴' }),

  // ── 購買人相同 P057–P068 ──
  samePurchaser({ title: '同一帳號第一件', note: '對照組，應通過。', tool: 'chatgpt', currency: 'USD', monthlyPeriods: 3, account: 'li-chengen', name: '李承恩', card: '1111' }),
  samePurchaser({ title: '同一帳號第二件（換卡）', note: '⚠ 漏洞示範：同一帳號多件申請但換卡、換發票，目前沒有規則示警。', tool: 'claude', currency: 'USD', account: 'li-chengen', name: '李承恩', card: '2222' }),
  samePurchaser({ title: '同一帳號第三件（再換卡）', note: '⚠ 同上，第三件仍全部通過；需靠審核員在案件列表發現。', tool: 'cursor', currency: 'USD', account: 'li-chengen', name: '李承恩', card: '3333' }),
  samePurchaser({ title: '不同帳號同名同姓', note: '⚠ 可能是同名不同人，也可能是分身帳號；目前不示警。', tool: 'perplexity', currency: 'USD', account: 'li-chengen-b', name: '李承恩', card: '4444' }),
  samePurchaser({ title: '不同帳號、姓名中間加空白', note: '⚠ 規避同名比對的寫法；目前不示警。', tool: 'gemini', account: 'li-chengen-c', name: '李 承恩', card: '5555' }),
  samePurchaser({ title: '分身帳號：第一個帳號', note: '對照組，應通過。', tool: 'canva', account: 'chou-a', name: '周品妤', card: '3141' }),
  samePurchaser({ title: '分身帳號：第二個帳號用同一張卡', note: '不同帳號但同卡同持卡人 → 付款來源紅燈，揪出分身。', tool: 'figma-ai', currency: 'JPY', account: 'chou-b', name: '周品妤', card: '3141', flags: RED_PAYMENT }),
  samePurchaser({ title: '年訂閱', note: '對照組，應通過。', tool: 'gemini', date: '2026-02-01', expense: '7800', account: 'kuo-zihao', name: '郭子豪', card: '6161' }),
  samePurchaser({ title: '同工具月訂閱且期間重疊', note: '⚠ 漏洞示範：與 P064 訂閱期間重疊，目前沒有規則示警。', tool: 'gemini', date: '2026-05-01', expense: '1950', monthlyPeriods: 3, account: 'kuo-zihao', name: '郭子豪', card: '6262' }),
  samePurchaser({ title: '同一帳號沿用第一件的卡', note: '與 P057 同卡 → 付款來源紅燈。', tool: 'claude', currency: 'USD', expense: '45', account: 'li-chengen', name: '李承恩', card: '1111', flags: RED_PAYMENT }),
  samePurchaser({ title: '分身帳號二：第一個帳號', note: '對照組，應通過。', tool: 'elevenlabs', currency: 'USD', account: 'tsai-a', name: '蔡宜臻', card: '7171', invoice: 'TS-77770001' }),
  samePurchaser({ title: '分身帳號二：換卡但沿用發票', note: '不同帳號、不同卡、同發票 → 發票指紋紅燈。', tool: 'descript', currency: 'USD', account: 'tsai-b', name: '蔡宜臻', card: '7272', invoice: 'TS-77770001', flags: RED_INVOICE }),

  // ── 刷卡人與購買人不同 P069–P080 ──
  payerMismatch({ title: '母親代付：第一位子女', note: '代付需附代付切結書；應通過。', tool: 'chatgpt', currency: 'USD', name: '許嘉宏', payer: 'representative', card: '6060', holder: '許淑芬' }),
  payerMismatch({ title: '母親代付：第二位子女', note: '同一代付卡 → 付款來源紅燈；兄弟姊妹屬合理情境，由審核員放行。', tool: 'midjourney', currency: 'USD', name: '許嘉玲', payer: 'representative', card: '6060', holder: '許淑芬', flags: RED_PAYMENT }),
  payerMismatch({ title: '親戚代付', note: '應通過；審核員核對代付切結書。', tool: 'suno', currency: 'USD', name: '羅子晴', payer: 'representative', card: '7131', holder: '羅文彬' }),
  payerMismatch({ title: '勾選本人卡但持卡人是別人', note: '⚠ 漏洞示範：申請人楊雅雯、持卡人楊振宇，卻選「本人卡」；未要求代付切結書，目前全部通過。', tool: 'notion-ai', name: '楊雅雯', payer: 'self_card', card: '8282', holder: '楊振宇' }),
  payerMismatch({ title: '本人卡但持卡人填英文名', note: '⚠ 系統無法判斷英文名是否為本人，目前通過。', tool: 'gamma', currency: 'USD', name: '江孟軒', payer: 'self_card', card: '8383', holder: 'Meng-Hsuan Chiang' }),
  payerMismatch({ title: '勾選代付但持卡人就是本人', note: '⚠ 申報矛盾（代付卻是自己的卡）；目前通過，但會多要求一份代付切結書。', tool: 'canva', name: '鄧宇彤', payer: 'representative', card: '8484', holder: '鄧宇彤' }),
  payerMismatch({ title: '公司卡代付：第一位員工', note: '應通過；審核員確認公司代付是否符合補助規定。', tool: 'github-copilot', currency: 'USD', name: '蘇冠廷', payer: 'representative', card: '9090', holder: COMPANY_CARD }),
  payerMismatch({ title: '公司卡代付：第二位員工', note: '同一公司卡 → 付款來源紅燈。', tool: 'cursor', currency: 'USD', name: '江詩涵', payer: 'representative', card: '9090', holder: COMPANY_CARD, flags: RED_PAYMENT }),
  payerMismatch({ title: '公司卡代付：第三位員工', note: '同一公司卡第三次 → 紅燈並列出前兩件。', tool: 'windsurf', currency: 'USD', name: '馮柏翰', payer: 'representative', card: '9090', holder: COMPANY_CARD, flags: RED_PAYMENT }),
  payerMismatch({ title: '同一代付人換另一張卡', note: '持卡人同為許淑芬但卡不同 → 不會連結到 P069/P070，應通過。', tool: 'ideogram', currency: 'USD', name: '許嘉慧', payer: 'representative', card: '6061', holder: '許淑芬' }),
  payerMismatch({ title: '本人卡自用', note: '對照組，應通過。', tool: 'replit', currency: 'USD', name: '賴冠宇', card: '7070' }),
  payerMismatch({ title: '該卡又替朋友代付', note: '賴冠宇的卡替韓宜蓁代付 → 付款來源紅燈。', tool: 'lovable', currency: 'USD', name: '韓宜蓁', payer: 'representative', card: '7070', holder: '賴冠宇', flags: RED_PAYMENT }),

  // ── 各種 AI 工具 P081–P094 ──
  aiTools({ title: '申報工具與護照不符', note: '申報 Midjourney，護照只寫 ChatGPT → 工具一致性紅燈。', tool: 'midjourney', currency: 'USD', passportTools: ['ChatGPT'], category: 'chat_search', name: '梁書豪', flags: { tool_consistency: 'needs_review' }, reasons: { tool_consistency: 'tool_mismatch' } }),
  aiTools({ title: '申報「ChatGPT Plus」', note: '方案名包含工具名 → 通過。', tool: 'ChatGPT Plus', company: 'OpenAI', category: 'chat_search', currency: 'USD', passportTools: ['ChatGPT'], name: '蕭語彤' }),
  aiTools({ title: '護照寫「Copilot」、申報 GitHub Copilot', note: '⚠ 包含比對會通過，但 Copilot 可能指 Microsoft Copilot；請人工留意。', tool: 'github-copilot', currency: 'USD', passportTools: ['Copilot'], name: '顏承佑' }),
  aiTools({ title: '護照寫 Claude Code、申報 Claude', note: '⚠ 子產品名稱包含比對通過；兩者訂閱方案不同，人工留意。', tool: 'claude', currency: 'USD', passportTools: ['Claude Code'], category: 'coding', name: '湯雅筑' }),
  aiTools({ title: '護照含多個工具', note: '護照含 Cursor 與 Claude，申報 Cursor → 通過。', tool: 'cursor', currency: 'USD', passportTools: ['Cursor', 'Claude'], name: '尹俊毅' }),
  aiTools({ title: '申報的是護照中的外掛', note: '護照 ChatGPT＋外掛 Zapier，申報 Zapier → 外掛節點也算，通過。', tool: 'zapier', currency: 'USD', passportTools: ['ChatGPT'], plugin: 'Zapier', name: '易欣妤' }),
  aiTools({ title: '清單外工具（其他自填）', note: 'Krea AI 不在核准清單但未被封鎖 → 可送出並通過，人工確認是否符合補助。', tool: 'Krea AI', company: 'Krea', category: 'image', currency: 'USD', name: '邵宏哲' }),
  aiTools({ title: '護照沒有任何工具節點', note: '無法比對申報工具 → 工具一致性紅燈（passport_tool_missing）。', tool: 'otter-ai', currency: 'USD', passportTools: [], name: '閻詩涵', flags: { tool_consistency: 'needs_review' }, reasons: { tool_consistency: 'passport_tool_missing' } }),
  aiTools({ title: '封鎖工具：DeepSeek', note: '中國 AI 服務 → 購買明細 API 應直接拒絕，案件停在草稿。', tool: 'DeepSeek', company: 'DeepSeek', category: 'chat_search', name: '侯立群', flow: 'blocked' }),
  aiTools({ title: '封鎖工具：Kimi', note: '應被拒絕，停在草稿。', tool: 'Kimi', company: 'Moonshot AI', category: 'chat_search', name: '伍佳怡', flow: 'blocked' }),
  aiTools({ title: '封鎖工具：豆包', note: '應被拒絕，停在草稿。', tool: '豆包', company: '字節跳動', category: 'chat_search', name: '辛柏言', flow: 'blocked' }),
  aiTools({ title: '無參考匯率的幣別（GBP）', note: '匯率合理性應為「待補」，人工確認換算。', tool: 'leonardo-ai', currency: 'OTHER', otherCurrency: 'GBP', expense: '20', converted: 850, name: '鄒佳臻', flags: { exchange_rate_reasonableness: 'missing' }, reasons: { exchange_rate_reasonableness: 'reference_rate_unavailable' } }),
  aiTools({ title: '匯率換算灌水', note: 'USD 20 申報 NT$900（試算 NT$630）→ 匯率合理性紅燈。', tool: 'pika', currency: 'USD', expense: '20', converted: 900, name: '祝冠廷', flags: { exchange_rate_reasonableness: 'needs_review' }, reasons: { exchange_rate_reasonableness: 'exchange_rate_out_of_band' } }),
  aiTools({ title: '工具名小寫＋日圓', note: '申報「notebooklm」、JPY 3000 → 大小寫不影響比對，通過。', tool: 'notebooklm', company: 'Google', category: 'chat_search', currency: 'JPY', expense: '3000', passportTools: ['NotebookLM'], name: '俞心瑜' }),

  // ── 其他邊界 P095–P100 ──
  edge({ title: '購買日早於補助期間一天', note: '2025-12-31 → 購買期程「不符」。', tool: 'chatgpt', currency: 'USD', date: '2025-12-31', name: '褚思廷', flags: { purchase_window: 'fail' } }),
  edge({ title: '購買日遠早於補助期間', note: '2025-06-01 → 購買期程「不符」。', tool: 'midjourney', currency: 'USD', date: '2025-06-01', name: '華宇辰', flags: { purchase_window: 'fail' } }),
  edge({ title: '高額消費觸及補助上限', note: 'NT$36,000 × 50% = 18,000 → 上限 NT$10,000。', tool: 'devin', expense: '36000', name: '樊致遠', reasons: { subsidy_estimate: 'cap_applied' } }),
  edge({ title: '特殊身分申請', note: '需多上傳特殊身分證明；規則應通過。', tool: 'grammarly', name: '柳芷涵', special: true }),
  edge({ title: '月訂閱 12 期', note: '應通過。', tool: 'motion', expense: '7200', monthlyPeriods: 12, name: '應子琪' }),
  edge({ title: '草稿沿用 P001 發票號碼', note: '草稿不參與比對、也不會產生勾稽結果。', tool: 'chatgpt', currency: 'USD', name: '慕容安', invoice: 'ZL-26000001', flow: 'draft' }),
];

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function endOfSubscription(start: string, months: number): string {
  const [year, month, day] = start.split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1 + months, day));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function convertToTwd(currency: Currency, expense: string): number {
  if (currency === 'OTHER') throw new Error('OTHER currency requires an explicit converted amount');
  return Math.round(Number(expense) * REFERENCE_FX_RATES_TWD[currency]);
}

export function buildDemoScenarios(): DemoScenario[] {
  const pool = [...NAME_POOL];
  const scenarios = INPUTS.map((input, index): DemoScenario => {
    const n = index + 1;
    const code = `P${pad(n, 3)}`;
    const approved = APPROVED_AI_TOOLS.find((tool) => tool.id === input.tool);
    const softwareName = approved?.label ?? input.tool;
    const category = input.category ?? approved?.category ?? 'chat_search';
    const name = input.name ?? pool.shift();
    if (!name) throw new Error('Demo name pool is exhausted');
    const currency = input.currency ?? 'TWD';
    const expense = input.expense ?? (currency === 'OTHER' ? '' : DEFAULT_EXPENSE[currency](n));
    const purchaseDate = input.date ?? `2026-${pad(1 + (n % 8), 2)}-${pad(2 + (n % 25), 2)}`;
    const periods = input.monthlyPeriods ?? null;
    return {
      code,
      group: input.group,
      title: input.title,
      reviewerNote: input.note,
      applicantKey: input.account ?? `demo-${code}`,
      flow: input.flow ?? 'submit',
      category,
      passportTools: input.passportTools ?? [softwareName],
      plugin: input.plugin ?? null,
      purchase: {
        billingCycle: periods === null ? 'annual' : 'monthly',
        billingPeriods: periods,
        softwareFunction: FUNCTION_BY_CATEGORY[category],
        otherFunction: null,
        softwareName,
        companyName: input.company ?? approved?.company ?? softwareName,
        purchaseDate,
        payerType: input.payer ?? 'self_card',
        originalCurrency: currency,
        otherCurrency: input.otherCurrency ?? null,
        originalExpense: expense,
        convertedTwd: input.converted ?? convertToTwd(currency, expense),
        specialStatus: input.special ?? false,
        invoiceNumber: input.invoice === undefined ? `ZL-${pad(26000000 + n, 8)}` : input.invoice,
        subscriptionStartDate: purchaseDate,
        subscriptionEndDate: endOfSubscription(purchaseDate, periods ?? 12),
        applicantName: name,
        // 7919 is coprime with 10000, so default last-fours never repeat.
        cardLastFour: input.card ?? pad((n * 7919 + 1234) % 10000, 4),
        cardholderName: input.holder ?? name,
      },
      expect: { ...ALL_PASS, ...input.flags },
      expectReason: input.reasons ?? {},
    };
  });
  if (scenarios.length !== 100) throw new Error(`Expected 100 demo scenarios, found ${scenarios.length}`);
  return scenarios;
}
