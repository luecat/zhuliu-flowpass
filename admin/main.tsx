import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import './admin.css';
import './review.css';
import { DataManager } from './data-manager';
import { SecurityAlertPublisher } from './security-alert-publisher';

const CSRF_COOKIE = 'flowpass_admin_csrf';
type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
type Session = { authenticated: boolean; displayName: string; mustChangePassword: boolean; passwordExpiresAt?: string };
type Case = { id: string; caseCode: string; state: string; submittedAt?: string; createdAt?: string; updatedAt?: string; rowVersion?: string | number; applicantName?: string; programName?: string; requestedAmountTwd?: number; calculatedAmountTwd?: number; approvedAmountTwd?: number; disbursedAmountTwd?: number; needsReviewCount?: number };
type RuleEvaluationView = { id: string; ruleCode: string; outcome: string; explanation: string; steps: Array<{ label: string; value: string }>; createdAt?: string };
type Attachment = { id: string; kind: string; requirementKey?: string; mediaType: string; byteSize: number; originalName: string; status: string; createdAt?: string; rowVersion?: number };
type Review = { action: string; toState: string; label: string; cta: string; fromStates: string[]; reasonLabel?: string; reasonPlaceholder?: string; amount?: 'approved' | 'disbursed'; supplement?: 'documents' | 'correction'; confirm?: boolean; danger?: boolean };
type ReviewDecision = { reason?: string; approvedAmountTwd?: number; disbursedAmountTwd?: number; title?: string; instructions?: string; passportReconfirmationRequired?: boolean };
type AdminRequest = <T>(url: string, init?: RequestInit) => Promise<T>;
type AiUsage = { provider: string; minuteKey: string; dayKey: string; models: Array<{ id: string; rpm: { used: number; limit: number; remaining: number }; tpm: { used: number; limit: number; remaining: number }; rpd: { used: number; limit: number; remaining: number }; recordedRuns: number }> };
const REVIEWS: Review[] = [
  { action: 'start_review', toState: 'under_review', label: '開始審核', cta: '開始審核', fromStates: ['submitted', 'resubmitted'] },
  { action: 'request_documents', toState: 'awaiting_documents', label: '要求補件', cta: '送出補件要求', fromStates: ['under_review'], supplement: 'documents', confirm: true },
  { action: 'return_correction', toState: 'returned_for_correction', label: '退回修正', cta: '退回申請人修正', fromStates: ['under_review'], supplement: 'correction', confirm: true },
  { action: 'approve', toState: 'approved', label: '核准', cta: '核准案件', fromStates: ['under_review'], reasonLabel: '核准說明', reasonPlaceholder: '請填寫核准原因或審核摘要', amount: 'approved', confirm: true },
  { action: 'reject', toState: 'rejected', label: '駁回', cta: '駁回案件', fromStates: ['under_review'], reasonLabel: '駁回原因', reasonPlaceholder: '請具體說明駁回原因', confirm: true, danger: true },
  { action: 'await_disbursement', toState: 'awaiting_disbursement', label: '列入撥款', cta: '列入撥款', fromStates: ['approved'], reasonLabel: '列入撥款說明', reasonPlaceholder: '請留下撥款排程或核對說明', confirm: true },
  { action: 'disburse', toState: 'disbursed', label: '標記已撥款', cta: '確認已撥款', fromStates: ['awaiting_disbursement'], reasonLabel: '撥款紀錄', reasonPlaceholder: '請留下撥款日期或核對資訊', amount: 'disbursed', confirm: true },
  { action: 'close', toState: 'closed', label: '結案', cta: '結案', fromStates: ['disbursed'], reasonLabel: '結案說明', reasonPlaceholder: '請說明結案原因', confirm: true },
];
class ApiError extends Error { constructor(readonly status: number, readonly code?: string, message?: string) { super(message ?? '服務暫時無法完成此操作，請稍後再試。'); } }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function cookie(name: string) { const found = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`)); try { return found ? decodeURIComponent(found.slice(name.length + 1)) : null; } catch { return null; } }
async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers); const method = (init.method ?? 'GET').toUpperCase();
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) { const token = cookie(CSRF_COOKIE); if (token) headers.set('x-csrf-token', token); }
  let response: Response; try { response = await fetch(url, { ...init, headers, credentials: 'same-origin' }); } catch { throw new ApiError(0, 'NETWORK_ERROR', '無法連線至管理服務，請確認本機後台已啟動。'); }
  const payload = await response.json().catch(() => ({})) as Envelope<T> & T;
  if (!response.ok) throw new ApiError(response.status, payload.error?.code, payload.error?.message);
  return (payload.data ?? payload) as T;
}
function sessionOf(value: unknown): Session { const v = record(value); return { authenticated: v.authenticated === true, displayName: string(v.displayName ?? v.display_name ?? v.name) ?? '管理員', mustChangePassword: v.mustChangePassword === true || v.must_change_password === true, passwordExpiresAt: string(v.passwordExpiresAt ?? v.password_expires_at) }; }
function caseOf(value: unknown): Case | null { const v = record(value), id = string(v.id); if (!id) return null; return { id, caseCode: string(v.caseCode ?? v.case_code) ?? id, state: string(v.state) ?? 'unknown', submittedAt: string(v.submittedAt ?? v.submitted_at), createdAt: string(v.createdAt ?? v.created_at), updatedAt: string(v.updatedAt ?? v.updated_at), rowVersion: number(v.rowVersion ?? v.row_version) ?? string(v.rowVersion ?? v.row_version), applicantName: string(v.applicantName ?? v.applicant_name ?? v.applicantDisplayName), programName: string(v.programName ?? v.program_name ?? v.programTitle), requestedAmountTwd: number(v.requestedAmountTwd ?? v.requested_amount_twd), calculatedAmountTwd: number(v.calculatedAmountTwd ?? v.calculated_amount_twd), approvedAmountTwd: number(v.approvedAmountTwd ?? v.approved_amount_twd), disbursedAmountTwd: number(v.disbursedAmountTwd ?? v.disbursed_amount_twd), needsReviewCount: number(v.needsReviewCount ?? v.needs_review_count) ?? 0 }; }
function evaluationOf(value: unknown): RuleEvaluationView | null {
  const v = record(value), id = string(v.id), ruleCode = string(v.ruleCode ?? v.rule_code), outcome = string(v.outcome);
  if (!id || !ruleCode || !outcome) return null;
  const steps = Array.isArray(v.steps)
    ? v.steps.map((step) => {
        const item = record(step);
        const label = string(item.label);
        const stepValue = string(item.value);
        return label && stepValue ? { label, value: stepValue } : null;
      }).filter((step): step is { label: string; value: string } => step !== null)
    : [];
  return { id, ruleCode, outcome, explanation: string(v.explanation) ?? '', steps, createdAt: string(v.createdAt ?? v.created_at) };
}
function ruleLabel(code: string) {
  return ({
    submission_window: '申請期程',
    purchase_window: '購買期程',
    invoice_duplicate: '發票重複',
    invoice_fingerprint: '發票指紋',
    transaction_fingerprint: '交易指紋',
    payment_source_fingerprint: '付款來源指紋',
    exchange_rate_reasonableness: '匯率合理性',
    tool_consistency: '工具一致性',
    subsidy_estimate: '補助試算',
    admin_data_recalculation: '補助重算',
  } as Record<string, string>)[code] ?? code;
}
function outcomeLabel(outcome: string) {
  return ({ pass: '通過', fail: '不符', needs_review: '紅燈', missing: '待補' } as Record<string, string>)[outcome] ?? outcome;
}
function attachmentOf(value: unknown): Attachment | null { const v = record(value), id = string(v.id), mediaType = string(v.mediaType ?? v.media_type), originalName = string(v.originalName ?? v.original_name), byteSize = number(v.byteSize ?? v.byte_size); if (!id || !mediaType || !originalName || byteSize === undefined) return null; return { id, kind: string(v.kind) ?? 'other', requirementKey: string(v.requirementKey ?? v.requirement_key), mediaType, byteSize, originalName, status: string(v.status) ?? 'unknown', createdAt: string(v.createdAt ?? v.created_at), rowVersion: number(v.rowVersion ?? v.row_version) }; }
function date(value?: string) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(d); }
function money(value?: number) { return typeof value === 'number' ? new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(value) : '—'; }
function bytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
function label(state: string) { return ({ draft: '草稿', submitted: '待審', under_review: '審核中', awaiting_documents: '待補件', returned_for_correction: '退回修正', approved: '已核准', rejected: '已駁回', awaiting_disbursement: '待撥款', disbursed: '已撥款', closed: '已結案' } as Record<string, string>)[state] ?? state; }
function uuid() { return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function Password({ id, title, value, setValue, auto = 'current-password' }: { id: string; title: string; value: string; setValue: (value: string) => void; auto?: string }) { const [show, setShow] = useState(false); return <div className="field"><label htmlFor={id}>{title}</label><div className="password"><input id={id} type={show ? 'text' : 'password'} value={value} autoComplete={auto} onChange={(e) => setValue(e.target.value)} required /><button type="button" onClick={() => setShow(!show)} aria-pressed={show}>{show ? '隱藏' : '顯示'}</button></div></div>; }
function Rules({ password }: { password: string }) { const values: [string, boolean][] = [['長度介於 8 到 128 個字元', Array.from(password).length >= 8 && Array.from(password).length <= 128], ['包含英文大寫字母', /[A-Z]/.test(password)], ['包含英文小寫字母', /[a-z]/.test(password)], ['包含數字', /\d/.test(password)], ['包含特殊字元', /[^A-Za-z0-9]/.test(password)], ['不含完整帳號名稱', !password.toLowerCase().includes('admin')]]; return <ul className="rules" aria-label="密碼規則">{values.map(([text, pass]) => <li className={pass ? 'pass' : ''} key={text}><span aria-hidden="true">{pass ? '✓' : '○'}</span>{text}</li>)}</ul>; }
function Login({ busy, error, submit, forgot }: { busy: boolean; error: string; submit: (account: string, password: string) => Promise<void>; forgot: () => void }) { const [password, setPassword] = useState(''); return <main className="auth"><section className="card"><p className="eyebrow">FLOWPASS · ADMIN</p><h1>管理後台登入</h1><p className="intro">登入後才能存取案件與審核資料。首次使用預設帳號後，系統會要求立即設定新密碼。</p><form onSubmit={(e) => { e.preventDefault(); void submit('admin', password).finally(() => setPassword('')); }}><div className="field"><span id="account-label">管理員帳號</span><output aria-labelledby="account-label" style={{ width: '100%', padding: '.68rem .75rem', border: '1px solid #b8c9bf', borderRadius: '.55rem', background: '#f3f7f4', color: '#1d2e26', fontWeight: 700 }}>admin</output></div><Password id="login-password" title="密碼" value={password} setValue={setPassword} />{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? '登入中…' : '登入'}</button></form><button className="link" onClick={forgot}>忘記密碼？</button><p className="security">遠端復原須先通過 Cloudflare Access Email OTP 驗證。</p></section></main>; }
function PasswordChange({ forced, busy, error, save, back }: { forced: boolean; busy: boolean; error: string; save: (current: string, next: string) => Promise<void>; back: () => void }) { const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState(''), [local, setLocal] = useState(''); const submit = (e: FormEvent) => { e.preventDefault(); if (next !== confirm) { setLocal('兩次輸入的新密碼不一致。'); return; } setLocal(''); void save(current, next); }; return <main className="auth"><section className="card"><p className="eyebrow">帳號安全</p><h1>{forced ? '請先變更初始密碼' : '變更密碼'}</h1><p className="intro">{forced ? '完成前無法使用其他管理功能。' : '更新後，其他裝置上的登入工作階段將失效。'}</p><form onSubmit={submit}><Password id="current-password" title="目前密碼" value={current} setValue={setCurrent} /><Password id="new-password" title="新密碼" value={next} setValue={setNext} auto="new-password" /><Rules password={next} /><Password id="confirm-password" title="確認新密碼" value={confirm} setValue={setConfirm} auto="new-password" />{(error || local) && <p className="error" role="alert">{local || error}</p>}<button className="primary" disabled={busy}>{busy ? '儲存中…' : '儲存新密碼'}</button></form>{!forced && <button className="link" onClick={back}>返回案件總覽</button>}</section></main>; }
function Recovery({ busy, error, start, complete, back }: { busy: boolean; error: string; start: () => Promise<string | null>; complete: (token: string, password: string) => Promise<void>; back: () => void }) { const [token, setToken] = useState<string | null>(null), [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [notice, setNotice] = useState(''), [local, setLocal] = useState(''); const doStart = () => void start().then((value) => { setToken(value); setNotice(value ? '身分驗證已完成，請設定新密碼。' : '請在受 Cloudflare Access 保護的遠端入口完成 Email OTP 後，再開始復原。'); }); return <main className="auth"><section className="card"><p className="eyebrow">帳號復原</p><h1>忘記密碼</h1><p className="intro">復原只接受已驗證的指定管理信箱，不會在本機顯示或傳送復原信箱。</p>{!token ? <><button className="primary" onClick={doStart} disabled={busy}>{busy ? '驗證中…' : '開始安全復原'}</button>{notice && <p className="notice" role="status">{notice}</p>}</> : <form onSubmit={(e) => { e.preventDefault(); if (password !== confirm) { setLocal('兩次輸入的新密碼不一致。'); return; } void complete(token, password); }}><Password id="recovery-password" title="新密碼" value={password} setValue={setPassword} auto="new-password" /><Rules password={password} /><Password id="recovery-confirm" title="確認新密碼" value={confirm} setValue={setConfirm} auto="new-password" /><button className="primary" disabled={busy}>{busy ? '重設中…' : '重設密碼並返回登入'}</button></form>}{(error || local) && <p className="error" role="alert">{local || error}</p>}<button className="link" onClick={back}>返回登入</button></section></main>; }
const SORT_KEYS: Array<[string, string, 'date' | 'number' | 'text']> = [
  ['submitted', '送出時間', 'date'],
  ['updated', '最後更新', 'date'],
  ['risk', '紅燈數', 'number'],
  ['code', '案件編號', 'text'],
];
const SORT_DIRECTION_LABELS: Record<'date' | 'number' | 'text', [string, string]> = {
  date: ['新 → 舊', '舊 → 新'],
  number: ['多 → 少', '少 → 多'],
  text: ['Z → A', 'A → Z'],
};
function sortKind(key: string) { return SORT_KEYS.find(([value]) => value === key)?.[2] ?? 'date'; }
function sortValue(item: Case, key: string): string | number {
  if (key === 'risk') return item.needsReviewCount ?? 0;
  if (key === 'updated') return item.updatedAt ?? '';
  if (key === 'code') return item.caseCode;
  return item.submittedAt ?? '';
}
function compareCases(left: Case, right: Case, key: string, direction: string) {
  const a = sortValue(left, key), b = sortValue(right, key);
  const base = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  if (base !== 0) return direction === 'asc' ? base : -base;
  // Stable, meaningful tiebreak so equal keys never shuffle between renders.
  return String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || String(right.id).localeCompare(String(left.id));
}
function Queue({ cases, selected, select, manage, refresh, refreshing, loadError, onRetry }: { cases: Case[]; selected: Case | null; select: (value: Case) => void; manage: (value: Case) => void; refresh: () => void; refreshing: boolean; loadError: string; onRetry: () => void }) {
  const saved = typeof window !== 'undefined' ? window.sessionStorage.getItem('flowpass-admin-queue-filter') : null;
  const initial = saved ? (() => { try { return JSON.parse(saved) as { query?: string; state?: string; quick?: string; sort?: string; direction?: string }; } catch { return {}; } })() : {};
  const [query, setQuery] = useState(initial.query ?? ''), [state, setState] = useState(initial.state ?? 'all'), [quick, setQuick] = useState(initial.quick ?? 'all');
  const [sort, setSort] = useState(SORT_KEYS.some(([value]) => value === initial.sort) ? initial.sort as string : 'submitted'), [direction, setDirection] = useState(initial.direction === 'asc' ? 'asc' : 'desc');
  useEffect(() => { window.sessionStorage.setItem('flowpass-admin-queue-filter', JSON.stringify({ query, state, quick, sort, direction })); }, [query, state, quick, sort, direction]);
  const list = useMemo(() => cases.filter((item) => {
    if (state !== 'all' && item.state !== state) return false;
    if (quick === 'high-risk' && !(item.needsReviewCount && item.needsReviewCount > 0)) return false;
    if (quick === 'awaiting-documents' && item.state !== 'awaiting_documents') return false;
    if (query.trim() && ![item.caseCode, item.applicantName, item.programName].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase())) return false;
    return true;
  }).slice().sort((left, right) => compareCases(left, right, sort, direction)), [cases, query, quick, state, sort, direction]);
  const states = [...new Set(cases.map((item) => item.state))].sort();
  const cards: [string, number, string][] = [
    ['待審案件', cases.filter((item) => ['submitted', 'under_review'].includes(item.state)).length, 'all'],
    ['紅燈例外', cases.filter((item) => (item.needsReviewCount ?? 0) > 0).length, 'high-risk'],
    ['待補件', cases.filter((item) => item.state === 'awaiting_documents').length, 'awaiting-documents'],
    ['今日新增', cases.filter((item) => item.submittedAt && new Date(item.submittedAt).toDateString() === new Date().toDateString()).length, 'all'],
  ];
  return <section className="work"><header className="work-head"><div><p className="eyebrow">案件總覽</p><h1>審核佇列</h1><p>預設依送出時間由新到舊排列，可用右側「排序」調整。</p></div><button className="secondary" onClick={refresh} disabled={refreshing}>{refreshing ? '更新中…' : '重新整理'}</button></header><div className="metrics">{cards.map(([text, value, filter]) => <button type="button" className={`metric${quick === filter && filter !== 'all' ? ' is-active' : ''}`} key={text} onClick={() => setQuick(filter)}><span>{text}</span><strong>{value}</strong></button>)}</div><section className="queue"><div className="queue-head"><div><h2>案件清單</h2><p>{list.length} 筆符合目前篩選；篩選會保存在此瀏覽器工作階段。</p></div><div className="filters"><label><span className="sr">搜尋案件</span><input type="search" value={query} placeholder="案件編號、申請人或方案" onChange={(e) => setQuery(e.target.value)} /></label><label><span className="sr">狀態</span><select value={state} onChange={(e) => setState(e.target.value)}><option value="all">所有狀態</option>{states.map((item) => <option value={item} key={item}>{label(item)}</option>)}</select></label><label><span className="sr">快速檢視</span><select value={quick} onChange={(e) => setQuick(e.target.value)}><option value="all">全部案件</option><option value="high-risk">高風險／紅燈</option><option value="awaiting-documents">待補件</option></select></label><label><span className="sr">排序依據</span><select value={sort} onChange={(e) => setSort(e.target.value)}>{SORT_KEYS.map(([value, text]) => <option value={value} key={value}>排序：{text}</option>)}</select></label><button type="button" className="sort-direction" aria-label={`切換排序方向，目前為${SORT_DIRECTION_LABELS[sortKind(sort)][direction === 'desc' ? 0 : 1]}`} onClick={() => setDirection(direction === 'desc' ? 'asc' : 'desc')}>{SORT_DIRECTION_LABELS[sortKind(sort)][direction === 'desc' ? 0 : 1]}</button></div></div>{loadError ? <div className="empty" role="alert"><h3>案件清單載入失敗</h3><p>{loadError}</p><button type="button" className="secondary" onClick={onRetry}>重試</button></div> : cases.length === 0 ? <Empty title="目前沒有案件" text="案件送出後會出現在這裡。" /> : list.length === 0 ? <Empty title="找不到符合的案件" text="請調整關鍵字或狀態篩選。" /> : <div className="table-wrap"><table><thead><tr><th>案件</th><th>申請人</th><th>方案</th><th>狀態</th><th>勾稽</th><th>最後更新</th><th><span className="sr">操作</span></th></tr></thead><tbody>{list.map((item) => <tr className={selected?.id === item.id ? 'selected' : ''} key={item.id}><td><strong>{item.caseCode}</strong><small>{date(item.submittedAt)}</small></td><td>{item.applicantName ?? '—'}</td><td>{item.programName ?? '—'}</td><td><span className={`status state-${item.state}`}>{label(item.state)}</span></td><td>{(item.needsReviewCount ?? 0) > 0 ? <span className="status state-needs-review">紅燈 {item.needsReviewCount}</span> : <span className="status state-pass">通過</span>}</td><td>{date(item.updatedAt)}</td><td><span className="queue-actions"><button className="link" onClick={() => select(item)} aria-label={`開啟案件 ${item.caseCode}`}>檢視</button><button className="link" onClick={() => manage(item)} aria-label={`管理案件 ${item.caseCode} 的全部資料`}>資料管理</button></span></td></tr>)}</tbody></table></div>}</section></section>;
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><h3>{title}</h3><p>{text}</p></div>; }
function Evaluations({ caseId }: { caseId: string }) {
  const [items, setItems] = useState<RuleEvaluationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<unknown>(`/admin/v1/cases/${encodeURIComponent(caseId)}/evaluations`).then((value) => {
      if (!active) return;
      const data = record(value);
      setItems((Array.isArray(data.evaluations) ? data.evaluations : []).map(evaluationOf).filter((item): item is RuleEvaluationView => item !== null));
    }).catch(() => { if (active) setError('勾稽結果暫時無法載入。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [caseId]);
  const ordered = useMemo(() => items.slice().sort((left, right) => {
    const rank = (outcome: string) => outcome === 'needs_review' ? 0 : outcome === 'fail' ? 1 : outcome === 'missing' ? 2 : 3;
    return rank(left.outcome) - rank(right.outcome);
  }), [items]);
  return <section className="evaluations" aria-labelledby="evaluations-title"><div className="attachments-head"><h3 id="evaluations-title">勾稽結果（{ordered.length}）</h3>{loading && <span role="status">載入中…</span>}</div>{error ? <p className="error" role="alert">{error}</p> : !loading && ordered.length === 0 ? <p className="attachments-empty">尚無規則判定紀錄。</p> : <ul className="evaluation-list">{ordered.map((item) => <li key={item.id} className={`evaluation-item outcome-${item.outcome}`}><div className="evaluation-head"><strong>{ruleLabel(item.ruleCode)}</strong><span className={`status state-${item.outcome === 'needs_review' ? 'needs-review' : item.outcome}`}>{outcomeLabel(item.outcome)}</span></div>{item.explanation && <p>{item.explanation}</p>}{item.steps.length > 0 && <dl className="evaluation-steps">{item.steps.map((step) => <div key={`${item.id}-${step.label}`}><dt>{step.label}</dt><dd>{step.value}</dd></div>)}</dl>}</li>)}</ul>}</section>;
}
function AiUsagePanel({ request, onBack }: { request: AdminRequest; onBack: () => void }) {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { setUsage(await request<AiUsage>('/admin/v1/ai-usage')); } catch (cause) { setError(cause instanceof Error ? cause.message : 'AI 用量無法載入。'); } finally { setLoading(false); } }, [request]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern; setState only runs after the awaited request settles.
  useEffect(() => { void load(); }, [load]);
  return <section className="work ai-usage"><header className="work-head"><div><button className="data-back" onClick={onBack}>← 返回案件總覽</button><p className="eyebrow">AI 使用監控</p><h1>AI 用量</h1><p>獨立追蹤模型的 RPM、TPM、RPD 與 AI 執行次數。</p></div><button className="secondary" onClick={() => void load()} disabled={loading}>{loading ? '更新中…' : '重新整理'}</button></header>{error && <div className="alert" role="alert">{error}</div>}{loading && !usage ? <div className="loading" role="status">正在載入 AI 用量…</div> : usage && <><div className="ai-usage-meta"><span>供應商：{usage.provider}</span><span>目前分鐘：{usage.minuteKey}</span><span>Pacific 日：{usage.dayKey}</span></div><div className="ai-usage-grid">{usage.models.map((model) => <article className="ai-usage-card" key={model.id}><h2>{model.id}</h2><p>已記錄 AI 執行：<strong>{model.recordedRuns}</strong> 次</p><dl><div><dt>RPM</dt><dd>{model.rpm.used} / {model.rpm.limit}<small>剩餘 {model.rpm.remaining}</small></dd></div><div><dt>TPM</dt><dd>{model.tpm.used.toLocaleString()} / {model.tpm.limit.toLocaleString()}<small>剩餘 {model.tpm.remaining.toLocaleString()} tokens</small></dd></div><div><dt>RPD</dt><dd>{model.rpd.used} / {model.rpd.limit}<small>剩餘 {model.rpd.remaining}</small></dd></div></dl></article>)}</div></>}</section>;
}
function Attachments({ caseId }: { caseId: string }) {
  const [documents, setDocuments] = useState<Attachment[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<unknown>(`/admin/v1/cases/${encodeURIComponent(caseId)}/documents`).then((value) => {
      if (!active) return;
      const data = record(value);
      setDocuments((Array.isArray(data.documents) ? data.documents : []).map(attachmentOf).filter((item): item is Attachment => item !== null));
    }).catch(() => { if (active) setError('附件暫時無法載入，請重新整理後再試。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [caseId]);
  const requirementLabels: Record<string, string> = { identity_front: '身分證正面', identity_back: '身分證反面', special_status_proof: '資格證明', purchase_proof: '購買憑證或發票', passbook_cover: '存摺封面影本', affidavit: '切結書', representative_affidavit: '代付切結書' };
  const kindLabels: Record<string, string> = { invoice: '發票／購買憑證', eligibility_proof: '資格證明', supplement: '補充文件', other: '其他附件' };
  const statusLabels: Record<string, string> = { ready: '可開啟', pending_vault: '儲存中', processing: '處理中', rejected: '無法使用' };
  return <section className="attachments" aria-labelledby="attachments-title"><div className="attachments-head"><h3 id="attachments-title">附件（{documents.length}）</h3>{loading && <span role="status">載入中…</span>}</div>{error ? <p className="error" role="alert">{error}</p> : !loading && documents.length === 0 ? <p className="attachments-empty">這筆案件目前沒有附件。</p> : <ul>{documents.map((document) => <li key={document.id}><div><strong>{document.originalName}</strong><small>{requirementLabels[document.requirementKey ?? ''] ?? kindLabels[document.kind] ?? '附件'} · {bytes(document.byteSize)} · {date(document.createdAt)}</small></div><div className="attachment-actions"><span className={`attachment-status attachment-${document.status}`}>{statusLabels[document.status] ?? document.status}</span>{document.status === 'ready' && <a href={`/admin/v1/documents/${encodeURIComponent(document.id)}/content`} target="_blank" rel="noopener noreferrer" aria-label={`開啟附件 ${document.originalName}`}>開啟附件</a>}</div></li>)}</ul>}</section>;
}
function Panel({ item, busy, error, close, clearError, update }: { item: Case; busy: boolean; error: string; close: () => void; clearError: () => void; update: (review: Review, decision: ReviewDecision) => Promise<void> }) {
  const availableReviews = REVIEWS.filter((value) => value.fromStates.includes(item.state));
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(item.approvedAmountTwd?.toString() ?? '');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [reconfirm, setReconfirm] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const confirmationTrigger = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const review = availableReviews.find((value) => value.action === name);
  const amountLabel = review?.amount === 'disbursed' ? '匯款金額' : '核准金額';
  // Runs once per panel open, not on every `confirming` toggle — otherwise reopening or
  // closing the confirmation dialog would reschedule this and steal focus back from
  // whatever the confirmation flow just focused (its trigger button, or itself).
  useEffect(() => {
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirming) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, confirming]);
  useEffect(() => {
    if (!confirming) return;
    const dialog = confirmationDialog.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const timer = window.setTimeout(() => dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const amountIsValid = amount.trim().length > 0 && Number.isSafeInteger(Number(amount)) && Number(amount) >= 0;
  const missing: string[] = [];
  if (review?.supplement) {
    if (!title.trim()) missing.push(review.supplement === 'documents' ? '補件項目' : '需修正項目');
    if (!instructions.trim()) missing.push(review.supplement === 'documents' ? '給申請人的補件說明' : '給申請人的修正說明');
  } else if (review) {
    if (review.amount && !amountIsValid) missing.push(amountLabel);
    if (review.reasonLabel && !reason.trim()) missing.push(review.reasonLabel);
  }
  const decision: ReviewDecision = review?.supplement
    ? {
        reason: instructions.trim(),
        title: title.trim(),
        instructions: instructions.trim(),
        ...(review.supplement === 'correction' ? { passportReconfirmationRequired: reconfirm } : {}),
      }
    : {
        ...(review?.action === 'start_review'
          ? { reason: '開始審查' }
          : review?.reasonLabel && reason.trim()
            ? { reason: reason.trim() }
            : {}),
        ...(review?.amount === 'approved' && amountIsValid ? { approvedAmountTwd: Number(amount) } : {}),
        ...(review?.amount === 'disbursed' && amountIsValid ? { disbursedAmountTwd: Number(amount) } : {}),
      };
  const chooseReview = (next: string) => {
    setName(next);
    setReason('');
    const nextReview = REVIEWS.find((value) => value.action === next);
    setAmount((nextReview?.amount === 'disbursed' ? item.disbursedAmountTwd ?? item.approvedAmountTwd : item.approvedAmountTwd)?.toString() ?? '');
    setTitle('');
    setInstructions('');
    setReconfirm(false);
    setConfirming(false);
    clearError();
  };
  const closeConfirmation = () => {
    const dialog = confirmationDialog.current;
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    setConfirming(false);
    window.setTimeout(() => confirmationTrigger.current?.focus(), 0);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!review || missing.length > 0 || busy) return;
    if (review.confirm) setConfirming(true);
    else void update(review, decision);
  };
  return <aside ref={panelRef} className="panel" role="dialog" aria-modal="true" aria-labelledby="case-title">
    <header><div><p className="eyebrow">案件詳情</p><h2 id="case-title">{item.caseCode}</h2></div><button ref={closeButtonRef} className="close" onClick={close} aria-label="關閉案件詳情">×</button></header>
    <dl><div><dt>狀態</dt><dd><span className={`status state-${item.state}`}>{label(item.state)}</span></dd></div><div><dt>申請人</dt><dd>{item.applicantName ?? '尚未提供'}</dd></div><div><dt>方案</dt><dd>{item.programName ?? '尚未提供'}</dd></div><div><dt>送出時間</dt><dd>{date(item.submittedAt)}</dd></div><div><dt>申請金額</dt><dd>{money(item.requestedAmountTwd)}</dd></div><div><dt>系統計算</dt><dd>{money(item.calculatedAmountTwd)}</dd></div><div><dt>核准金額</dt><dd>{money(item.approvedAmountTwd)}</dd></div><div><dt>最後更新</dt><dd>{date(item.updatedAt)}</dd></div></dl>
    <Evaluations key={`eval-${item.id}`} caseId={item.id} />
    <Attachments key={item.id} caseId={item.id} />
    {availableReviews.length === 0 ? <section className="review review-empty"><h3>更新案件狀態</h3><p>這個狀態目前沒有可執行的審核動作。</p></section> : <form className="review" onSubmit={submit}>
      <h3>更新案件狀態</h3>
      <p>只會顯示目前狀態可執行的動作；送出後會建立審核紀錄。</p>
      <div className="field"><label htmlFor="review-action">審核動作</label><select id="review-action" value={name} onChange={(event) => chooseReview(event.target.value)}><option value="" disabled>請選擇處理方式</option>{availableReviews.map((value) => <option value={value.action} key={value.action}>{value.label}</option>)}</select></div>
      {review?.supplement && <>
        <aside className={`review-callout review-callout--${review.supplement}`} aria-label={review.supplement === 'documents' ? '補件說明' : '退回修正說明'}>
          {review.supplement === 'documents' ? (
            <>
              <strong>要求補件：請申請人補上傳文件</strong>
              <p>適用於發票、身分證明、切結書等缺件或影像不清。申請人會看到上傳檔案畫面，不會被要求改寫申請內容。</p>
            </>
          ) : (
            <>
              <strong>退回修正：請申請人改申請內容</strong>
              <p>適用於用途、預算、工具或護照敘述有誤。申請人會看到修正說明與「前往修改」入口，不是補件上傳。</p>
            </>
          )}
        </aside>
        <div className="field"><label htmlFor="supplement-title">{review.supplement === 'documents' ? '補件項目（必填）' : '需修正項目（必填）'}</label><input id="supplement-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={review.supplement === 'documents' ? '例如：完整的購買發票' : '例如：申請用途寫法與實際流程不符'} /></div>
        <div className="field"><label htmlFor="supplement-instructions">{review.supplement === 'documents' ? '給申請人的補件說明（必填）' : '給申請人的修正說明（必填）'}</label><textarea id="supplement-instructions" rows={4} maxLength={10000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={review.supplement === 'documents' ? '請具體說明缺少的文件、內容或清晰度要求' : '請具體說明哪一段要改、正確應寫成什麼'} /></div>
        {review.supplement === 'correction' && <label className="choice"><input type="checkbox" checked={reconfirm} onChange={(event) => setReconfirm(event.target.checked)} />修正後請申請人重新確認申請內容</label>}
      </>}
      {review?.amount && <div className="field"><label htmlFor="approved-amount">{amountLabel}（新台幣，必填）</label><input id="approved-amount" type="number" inputMode="numeric" min="0" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>}
      {review?.reasonLabel && <div className="field"><label htmlFor="reason">{review.reasonLabel}（必填）</label><p id="reason-applicant-visible" className="field-hint">原因會被申請者看到</p><textarea id="reason" rows={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={review.reasonPlaceholder} aria-describedby="reason-applicant-visible" /></div>}
      {!review && <p className="review-guidance">選擇處理方式後，這裡會顯示所需資料與送出按鈕。</p>}
      {review && missing.length > 0 && <p className="review-requirements" role="status">尚需填寫：{missing.join('、')}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {review && <button ref={confirmationTrigger} className={`primary${review.danger ? ' danger' : ''}`} aria-busy={busy} disabled={busy || missing.length > 0}>{busy ? '更新中…' : review.cta}</button>}
    </form>}
    {confirming && review && <dialog ref={confirmationDialog} className="review-confirm-dialog" aria-modal="true" aria-labelledby="review-confirm-title" onCancel={(event) => { event.preventDefault(); closeConfirmation(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeConfirmation(); } }}>
      <p className="eyebrow">送出前確認</p>
      <h4 id="review-confirm-title">確認{review.cta}</h4>
      <p>案件狀態將更新為「{label(review.toState)}」，並建立一筆審核紀錄。</p>
      <dl>
        <div><dt>執行動作</dt><dd>{review.label}</dd></div>
        {review.supplement && <><div><dt>{review.supplement === 'documents' ? '補件項目' : '需修正項目'}</dt><dd>{title.trim()}</dd></div><div><dt>給申請人的說明</dt><dd>{instructions.trim()}</dd></div></>}
        {review.supplement === 'correction' && <div><dt>申請人需重新確認</dt><dd>{reconfirm ? '是' : '否'}</dd></div>}
        {review.amount && <div><dt>{amountLabel}</dt><dd>{money(Number(amount))}</dd></div>}
        {review.reasonLabel && <div><dt>{review.reasonLabel}</dt><dd>{reason.trim()}</dd></div>}
      </dl>
      <div className="review-confirm-actions"><button type="button" className="secondary" data-initial-focus onClick={closeConfirmation}>返回修改</button><button type="button" className={`primary${review.danger ? ' danger' : ''}`} disabled={busy} aria-busy={busy} onClick={() => { closeConfirmation(); void update(review, decision); }}>{busy ? '更新中…' : `確認${review.cta}`}</button></div>
    </dialog>}
  </aside>;
}
function App() { const [session, setSession] = useState<Session | null>(null), [view, setView] = useState<'login' | 'recovery' | 'password' | 'dashboard' | 'ai-usage' | 'security-incidents'>('login'), [cases, setCases] = useState<Case[]>([]), [selected, setSelected] = useState<Case | null>(null), [managing, setManaging] = useState<Case | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [queueError, setQueueError] = useState(''), [authError, setAuthError] = useState(''), [panelError, setPanelError] = useState(''), [notice, setNotice] = useState('');
  const refreshSession = async () => { try { const next = sessionOf(await api<unknown>('/admin/v1/session')); setSession(next); setView(!next.authenticated ? 'login' : next.mustChangePassword ? 'password' : 'dashboard'); return next; } catch (e) { const err = e as ApiError; if (err.status === 401 || err.status === 403) { setSession(null); setView('login'); return null; } setAuthError(err.message); return null; } };
  const load = async () => { setLoading(true); setQueueError(''); try { const data = record(await api<unknown>('/admin/v1/cases')); const next = (Array.isArray(data.cases) ? data.cases : []).map(caseOf).filter((value): value is Case => value !== null); setCases(next); setSelected((old) => old ? next.find((item) => item.id === old.id) ?? null : null); } catch (e) { const err = e as ApiError; if (err.status === 401) { setSession(null); setView('login'); } else setQueueError(err.message || '案件清單暫時無法載入。'); } finally { setLoading(false); } };
  useEffect(() => { const timer = window.setTimeout(() => { void refreshSession(); }, 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => { if (view !== 'dashboard' || !session?.authenticated || session.mustChangePassword) return; const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [view, session?.authenticated, session?.mustChangePassword]);
  const login = async (displayName: string, password: string) => { setBusy(true); setAuthError(''); try { await api('/admin/v1/sessions', { method: 'POST', body: JSON.stringify({ displayName, password }) }); const next = await refreshSession(); if (next?.authenticated) setNotice(next.mustChangePassword ? '請先設定新密碼。' : '已登入管理後台。'); } catch (e) { setAuthError((e as ApiError).message || '登入失敗，請確認帳號或密碼。'); } finally { setBusy(false); } };
  const change = async (currentPassword: string, newPassword: string) => { setBusy(true); setAuthError(''); try { await api('/admin/v1/password/change', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); await refreshSession(); setNotice('密碼已更新；其他登入工作階段已失效。'); } catch (e) { setAuthError((e as ApiError).message); } finally { setBusy(false); } };
  const start = async () => { setBusy(true); setAuthError(''); try { const data = record(await api<unknown>('/admin/v1/password-recovery/start', { method: 'POST', body: '{}' })); return string(data.challengeToken ?? data.token ?? record(data.challenge).token) ?? null; } catch (e) { setAuthError((e as ApiError).message); return null; } finally { setBusy(false); } };
  const complete = async (challengeToken: string, newPassword: string) => { setBusy(true); setAuthError(''); try { await api('/admin/v1/password-recovery/complete', { method: 'POST', body: JSON.stringify({ challengeToken, newPassword }) }); setView('login'); setNotice('密碼已重設，請使用新密碼登入。'); } catch (e) { setAuthError((e as ApiError).message); } finally { setBusy(false); } };
  const logout = async () => { setBusy(true); setAuthError(''); try { await api('/admin/v1/sessions/current', { method: 'DELETE' }); } catch (e) { if ((e as ApiError).status !== 401) setAuthError((e as ApiError).message); } finally { setSession(null); setCases([]); setSelected(null); setManaging(null); setView('login'); setBusy(false); setNotice('已登出管理後台。'); } };
  const update = async (review: Review, decision: ReviewDecision) => { if (!selected) return; setBusy(true); setPanelError(''); const headers: Record<string, string> = { 'idempotency-key': uuid() }; if (selected.rowVersion !== undefined) headers['if-match'] = `"${selected.rowVersion}"`; const body: Record<string, unknown> = { action: review.action, toState: review.toState, ...decision }; try { const data = record(await api<unknown>(`/admin/v1/cases/${encodeURIComponent(selected.id)}/review`, { method: 'POST', headers, body: JSON.stringify(body) })); const changed = caseOf(data.case ?? data); if (changed) setSelected(changed); setNotice(`案件 ${selected.caseCode} 已更新為「${review.label}」。`); await load(); } catch (e) { const err = e as ApiError; setPanelError(err.status === 409 ? '此案件已被更新，請重新整理後檢查最新狀態。' : err.message); } finally { setBusy(false); } };
  if (view === 'login') return <Login busy={busy} error={authError} submit={login} forgot={() => { setAuthError(''); setView('recovery'); }} />;
  if (view === 'recovery') return <Recovery busy={busy} error={authError} start={start} complete={complete} back={() => { setAuthError(''); setView('login'); }} />;
  if (view === 'password') return <PasswordChange forced={session?.mustChangePassword === true} busy={busy} error={authError} save={change} back={() => setView('dashboard')} />;
  return <div className="shell"><a className="skip" href="#main">跳到主要內容</a><header className="top"><a className="brand" href="#main" onClick={() => { setManaging(null); setView('dashboard'); }}><b>FP</b><strong>FlowPass</strong><small>管理後台</small></a><nav className="top-nav" aria-label="管理後台"><span>{session?.displayName ?? '管理員'}</span>{view === 'dashboard' && <><button className="link" onClick={() => { setAuthError(''); setView('ai-usage'); }}>AI 用量</button><button className="link" onClick={() => { setAuthError(''); setView('security-incidents'); }}>資安提醒</button></>}<button className="link" onClick={() => { setAuthError(''); setView('password'); }}>變更密碼</button><button className="link" onClick={() => void logout()} disabled={busy}>登出</button></nav></header>{notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="關閉通知">×</button></div>}<main id="main">{view === 'ai-usage' ? <AiUsagePanel request={api} onBack={() => setView('dashboard')} /> : view === 'security-incidents' ? <SecurityAlertPublisher request={api} onBack={() => setView('dashboard')} /> : managing ? <DataManager caseId={managing.id} caseCode={managing.caseCode} request={api} onBack={() => setManaging(null)} onDeleted={(result) => { setManaging(null); setSelected(null); setNotice(`案件 ${result.caseCode} 及其全部相關資料已永久刪除。`); void load(); }} /> : loading && !cases.length && !queueError ? <div className="loading" role="status">正在載入案件資料…</div> : <Queue cases={cases} selected={selected} select={setSelected} manage={(item) => { setSelected(null); setManaging(item); }} refresh={() => void load()} refreshing={loading} loadError={queueError} onRetry={() => void load()} />}</main>{!managing && selected && <div className="layer"><button className="backdrop" onClick={() => setSelected(null)} aria-label="關閉案件詳情" /><Panel key={`${selected.id}:${selected.state}:${selected.rowVersion ?? ''}`} item={selected} busy={busy} error={panelError} close={() => setSelected(null)} clearError={() => setPanelError('')} update={update} /></div>}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
