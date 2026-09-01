import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  AdminDataField,
  AdminDataRecord,
  AdminFieldPatchResult,
  AdminPassportDataSnapshot,
  PurgeAuthorization,
  PurgePreview,
  PurgeResult,
} from '../shared/admin-data-management-contract';
import './data-manager.css';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;

interface DataManagerProps {
  caseId: string;
  caseCode: string;
  request: Request;
  onBack: () => void;
  onDeleted: (result: PurgeResult) => void;
}

type EditTarget = { record: AdminDataRecord; field: AdminDataField };

const KIND_LABELS = { source: '主要資料', derived: '系統衍生', history: '歷程紀錄', system: '系統紀錄' } as const;

function displayValue(field: AdminDataField): string {
  if (field.value === null || field.value === undefined || field.value === '') return '—';
  if (field.type === 'boolean') return field.value ? '是' : '否';
  if (field.type === 'money' && typeof field.value === 'number') return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(field.value);
  if ((field.type === 'date' || field.type === 'datetime') && typeof field.value === 'string') {
    const date = new Date(field.value);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat('zh-TW', field.type === 'date' ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
  }
  if (typeof field.value === 'object') return JSON.stringify(field.value, null, 2);
  return String(field.value);
}

function editorValue(field: AdminDataField): string {
  if (field.value === null || field.value === undefined) return '';
  if (field.type === 'json') return JSON.stringify(field.value, null, 2);
  if (field.type === 'datetime' && typeof field.value === 'string') {
    const parsed = new Date(field.value);
    if (!Number.isNaN(parsed.getTime())) {
      const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, 16);
    }
  }
  return String(field.value);
}

function patchValue(field: AdminDataField, value: string): unknown {
  if (field.type === 'json') return JSON.parse(value);
  if (field.type === 'integer' || field.type === 'money') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error('請輸入有效數字。');
    return parsed;
  }
  if (field.type === 'boolean') return value === 'true';
  if (field.type === 'datetime') return value ? new Date(value).toISOString() : null;
  return value;
}

function statusOptions(target: EditTarget): Array<[string, string]> {
  if (target.record.resource === 'cases' && target.field.key === 'state') return [
    ['draft', '尚未送出'], ['submitted', '已送出'], ['under_review', '審查中'], ['awaiting_documents', '待補件'],
    ['returned_for_correction', '待修正'], ['resubmitted', '已補件'], ['approved', '已核定'], ['rejected', '未核定'],
    ['awaiting_disbursement', '待撥款'], ['disbursed', '已撥款'], ['closed', '已結案'],
  ];
  if (target.record.resource === 'case_tasks' && target.field.key === 'status') return [['open', '待處理'], ['opened', '已開啟'], ['completed', '已完成'], ['cancelled', '已取消'], ['expired', '已逾期']];
  if (target.record.resource === 'alerts' && target.field.key === 'status') return [['open', '待處理'], ['acknowledged', '已確認'], ['resolved', '已解決'], ['dismissed', '已略過']];
  return [];
}

function FieldEditor({ target, busy, close, save }: { target: EditTarget; busy: boolean; close: () => void; save: (value: unknown) => Promise<void> }) {
  const [value, setValue] = useState(() => editorValue(target.field));
  const [error, setError] = useState('');
  const statuses = statusOptions(target);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try { setError(''); void save(patchValue(target.field, value)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '欄位格式不正確。'); }
  };
  return <div className="data-modal" role="presentation"><button className="data-modal-backdrop" aria-label="關閉編輯視窗" onClick={close} /><section className="data-dialog" role="dialog" aria-modal="true" aria-labelledby="field-editor-title">
    <p className="eyebrow">直接覆寫</p><h2 id="field-editor-title">編輯「{target.field.label}」</h2>
    <p className="data-dialog-note">儲存後會立即取代目前資料，不會建立新版本。系統仍會保留不含敏感內容的修改稽核。</p>
    <dl><div><dt>資料項目</dt><dd>{target.record.title}</dd></div><div><dt>欄位</dt><dd>{target.field.key}</dd></div></dl>
    <form onSubmit={submit}>
      <label className="data-editor-field"><span>{target.field.label}</span>{statuses.length ? <select value={value} onChange={(event) => setValue(event.target.value)}>{statuses.map(([code, label]) => <option value={code} key={code}>{label}</option>)}</select> : target.field.type === 'json' ? <textarea rows={12} spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} /> : target.field.type === 'boolean' ? <select value={value} onChange={(event) => setValue(event.target.value)}><option value="true">是</option><option value="false">否</option></select> : <input type={target.field.type === 'money' || target.field.type === 'integer' ? 'number' : target.field.type === 'date' ? 'date' : target.field.type === 'datetime' ? 'datetime-local' : 'text'} step={target.field.type === 'money' || target.field.type === 'integer' ? '1' : undefined} value={value} onChange={(event) => setValue(event.target.value)} />}</label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="data-dialog-actions"><button type="button" className="secondary" onClick={close} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy ? '儲存中…' : '確認覆寫'}</button></div>
    </form>
  </section></div>;
}

function PurgeDialog({ caseId, caseCode, request, close, complete }: { caseId: string; caseCode: string; request: Request; close: () => void; complete: (result: PurgeResult) => void }) {
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [typedCode, setTypedCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; void request<PurgePreview>(`/admin/v1/data/passports/${encodeURIComponent(caseId)}/purge-preview`, { method: 'POST', body: '{}' }).then((value) => { if (active) setPreview(value); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '無法載入刪除範圍。'); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, [caseId, request]);
  const purge = async (event: FormEvent) => {
    event.preventDefault(); if (!preview || typedCode !== caseCode || !password) return;
    setBusy(true); setError('');
    try {
      const authorization = await request<PurgeAuthorization>(`/admin/v1/data/passports/${encodeURIComponent(caseId)}/purge-authorizations`, { method: 'POST', body: JSON.stringify({ previewHash: preview.previewHash, caseCode: typedCode, password }) });
      setPassword('');
      const result = await request<PurgeResult>(`/admin/v1/data/passports/${encodeURIComponent(caseId)}/purge`, { method: 'POST', body: JSON.stringify({ token: authorization.token }) });
      complete(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '永久刪除未完成。'); setBusy(false); }
  };
  const rowCount = preview?.tables.reduce((sum, table) => sum + table.count, 0) ?? 0;
  return <div className="data-modal" role="presentation"><button className="data-modal-backdrop" aria-label="取消永久刪除" onClick={close} /><section className="data-dialog data-danger-dialog" role="dialog" aria-modal="true" aria-labelledby="purge-title">
    <p className="eyebrow danger-text">不可復原的操作</p><h2 id="purge-title">永久刪除這本護照的所有資料</h2>
    {busy && !preview ? <p role="status">正在計算影響範圍…</p> : preview ? <form onSubmit={purge}>
      <p className="data-danger-copy">只會刪除案件 <strong>{preview.caseCode}</strong> 及其全部關聯資料；同一申請人的其他護照不會被刪除。</p>
      <div className="purge-summary"><div><span>資料紀錄</span><strong>{rowCount}</strong></div><div><span>附件</span><strong>{preview.attachments.length}</strong></div><div><span>保留的其他護照</span><strong>{preview.preservedSiblingCases}</strong></div></div>
      <details><summary>檢視完整刪除清單</summary><div className="purge-table"><table><thead><tr><th>資料表</th><th>筆數</th></tr></thead><tbody>{preview.tables.filter((table) => table.count > 0).map((table) => <tr key={table.table}><td>{table.table}</td><td>{table.count}</td></tr>)}</tbody></table></div><p>附件容量：{new Intl.NumberFormat('zh-TW').format(preview.attachmentBytes)} bytes</p><p>現有備份：{preview.backups.length} 份；完成後只保留刪除後的新備份。</p></details>
      <label className="data-editor-field"><span>輸入案件編號「{caseCode}」</span><input autoComplete="off" value={typedCode} onChange={(event) => setTypedCode(event.target.value)} /></label>
      <label className="data-editor-field"><span>管理員密碼</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="data-dialog-actions"><button type="button" className="secondary" onClick={close} disabled={busy}>取消</button><button className="primary data-purge-button" disabled={busy || typedCode !== caseCode || !password}>{busy ? '永久刪除中…' : '永久刪除全部相關資料'}</button></div>
    </form> : <><p className="error" role="alert">{error || '無法載入刪除範圍。'}</p><button className="secondary" onClick={close}>返回</button></>}
  </section></div>;
}

export function DataManager({ caseId, caseCode, request, onBack, onDeleted }: DataManagerProps) {
  const [snapshot, setSnapshot] = useState<AdminPassportDataSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [raw, setRaw] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(''); try { setSnapshot(await request<AdminPassportDataSnapshot>(`/admin/v1/data/passports/${encodeURIComponent(caseId)}`)); } catch (cause) { setError(cause instanceof Error ? cause.message : '資料無法載入。'); } finally { setLoading(false); } }, [caseId, request]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase(); if (!snapshot || !needle) return snapshot?.groups ?? [];
    return snapshot.groups.map((group) => ({ ...group, records: group.records.filter((record) => [record.title, record.table, record.id, ...record.fields.flatMap((field) => [field.label, field.key, displayValue(field)])].join(' ').toLowerCase().includes(needle)) })).filter((group) => group.records.length > 0);
  }, [snapshot, query]);
  const save = async (value: unknown) => {
    if (!editing?.record.rowVersion) return;
    setSaving(true); setError('');
    try {
      const result = await request<AdminFieldPatchResult>(`/admin/v1/data/passports/${encodeURIComponent(caseId)}/fields`, { method: 'PATCH', body: JSON.stringify({ resource: editing.record.resource, recordId: editing.record.id, field: editing.field.key, value, expectedRowVersion: editing.record.rowVersion }) });
      setEditing(null); setNotice(result.recalculated.length ? '資料已覆寫，相關計算結果已同步更新。' : '資料已覆寫。'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '資料無法儲存。'); }
    finally { setSaving(false); }
  };
  return <section className="data-manager">
    <header className="data-manager-head"><div><button className="data-back" onClick={onBack}>← 返回案件清單</button><p className="eyebrow">單一護照資料管理</p><h1>{snapshot?.caseCode ?? caseCode}</h1><p>{snapshot ? `${snapshot.applicantLabel} · ${snapshot.stateLabel} · 最後更新 ${new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.updatedAt))}` : '載入護照資料中…'}</p></div><button className="data-danger-link" onClick={() => setPurging(true)} disabled={!snapshot}>永久刪除這本護照</button></header>
    {notice && <div className="data-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="關閉通知">×</button></div>}
    {error && <div className="data-error" role="alert">{error}<button onClick={() => setError('')} aria-label="關閉錯誤">×</button></div>}
    {snapshot?.requiresAiRefresh && <div className="data-ai-warning">部分來源資料曾經人工修改；AI 衍生內容可能需要重新產生。</div>}
    <div className="data-toolbar"><label><span className="sr">搜尋所有護照資料</span><input type="search" placeholder="搜尋欄位、內容或紀錄編號" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="data-view-toggle" role="group" aria-label="顯示方式"><button className={!raw ? 'active' : ''} onClick={() => setRaw(false)}>易讀檢視</button><button className={raw ? 'active' : ''} onClick={() => setRaw(true)}>原始欄位</button></div><button className="secondary" onClick={() => void load()} disabled={loading}>{loading ? '更新中…' : '重新整理'}</button></div>
    {loading && !snapshot ? <div className="loading" role="status">正在安全解密並整理資料…</div> : groups.length === 0 ? <div className="empty"><h3>找不到符合的資料</h3><p>請調整搜尋關鍵字。</p></div> : <div className={`data-groups${raw ? ' raw' : ''}`}>{groups.map((group) => <details className="data-group" open key={group.key}><summary><span>{group.label}</span><small>{group.records.length} 筆紀錄</small></summary><div className="data-records">{group.records.map((record) => <article className="data-record" key={`${record.table}:${record.id}`}><header><div><span className={`data-kind kind-${record.kind}`}>{KIND_LABELS[record.kind]}</span><h2>{record.title}</h2>{raw && <code>{record.table} · {record.id}</code>}</div><span>{record.fields.filter((field) => field.editable).length ? '可校正' : '唯讀'}</span></header><dl>{record.fields.map((field) => <div className={field.editable ? 'editable' : ''} key={field.key}><dt>{raw ? field.key : field.label}{field.storage?.encrypted && <small>加密儲存</small>}</dt><dd><pre>{displayValue(field)}</pre>{field.editable ? <button onClick={() => { setError(''); setEditing({ record, field }); }}>編輯</button> : <span title={field.lockedReason}>唯讀</span>}</dd></div>)}</dl></article>)}</div></details>)}</div>}
    {editing && <FieldEditor target={editing} busy={saving} close={() => setEditing(null)} save={save} />}
    {purging && <PurgeDialog caseId={caseId} caseCode={snapshot?.caseCode ?? caseCode} request={request} close={() => setPurging(false)} complete={onDeleted} />}
  </section>;
}
