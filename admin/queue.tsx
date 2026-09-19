import { useEffect, useMemo, useState } from 'react';
import type { Case } from './types';
import { date, label } from './format';

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
function sortKind(key: string) {
  return SORT_KEYS.find(([value]) => value === key)?.[2] ?? 'date';
}
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

export function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><h3>{title}</h3><p>{text}</p></div>;
}

export function Queue({ cases, selected, select, manage, refresh, refreshing, loadError, onRetry }: { cases: Case[]; selected: Case | null; select: (value: Case) => void; manage: (value: Case) => void; refresh: () => void; refreshing: boolean; loadError: string; onRetry: () => void }) {
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
