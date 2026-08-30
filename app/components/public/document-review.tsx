'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';

type DocumentKind = 'invoice' | 'eligibility_proof' | 'supplement' | 'other';
interface DocumentRecord { id: string; kind: DocumentKind; mediaType: string; byteSize: number; status: string; rowVersion: number; }
interface DocumentFieldRecord { id: string; documentId: string; fieldName: string; originalValue: string | null; normalizedValue: string | null; effectiveValue: string | null; confidence: number | null; sourcePage: number | null; sourceBox: { x: number; y: number; width: number; height: number } | null; parserReasonCode: string | null; }
interface RuleEvaluationRecord { evaluationKind: string; outcome: string; createdAt: string; }

const MAX_BYTES = 12 * 1024 * 1024;

function caseIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('caseId');
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function DocumentReview({ suppliedCaseId }: { suppliedCaseId?: string } = {}) {
  const [caseId, setCaseId] = useState<string | null>(suppliedCaseId ?? caseIdFromLocation());
  const api = useMemo(() => new PublicApiClient(), []);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [fields, setFields] = useState<DocumentFieldRecord[]>([]);
  const [fieldEdits, setFieldEdits] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<DocumentKind>('invoice');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [caseState, setCaseState] = useState<string>('draft');
  const [evaluations, setEvaluations] = useState<RuleEvaluationRecord[]>([]);

  useEffect(() => {
    const onCaseReady = (event: Event) => {
      const detail = (event as CustomEvent<{ caseId?: unknown }>).detail;
      if (typeof detail?.caseId === 'string' && detail.caseId) setCaseId(detail.caseId);
    };
    window.addEventListener('flowpass-case-ready', onCaseReady);
    return () => window.removeEventListener('flowpass-case-ready', onCaseReady);
  }, []);

  const load = useCallback(async () => {
    if (!caseId) return;
    try {
      const [result, current, fieldResult, ruleResult] = await Promise.all([
        api.read<{ documents: DocumentRecord[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`),
        api.read<{ state: string }>(`/api/v1/cases/${encodeURIComponent(caseId)}`),
        api.read<{ fields: DocumentFieldRecord[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/document-fields`),
        api.read<{ evaluations: RuleEvaluationRecord[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/rules`).catch(() => ({ evaluations: [] })),
      ]);
      setDocuments(result.documents);
      setFields(fieldResult.fields);
      setCaseState(current.state);
      setEvaluations(ruleResult.evaluations);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof PublicApiError && error.status === 404 ? '尚未建立申請草稿，完成前面的問題後即可上傳。' : '文件清單暫時無法載入。');
    }
  }, [api, caseId]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function upload() {
    if (!caseId || !file) return;
    if (file.size > MAX_BYTES) { setMessage('單一檔案不可超過 12 MiB。'); return; }
    setBusy(true); setProgress(0); setMessage('');
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      await api.upload(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`, { file, kind, ifMatch: `"${current.rowVersion}"`, onProgress: setProgress });
      setFile(null); setMessage('文件已安全保存，接下來會進入處理流程。'); await load();
    } catch (error) {
      if (error instanceof PublicApiError && error.code === 'FILE_TOO_LARGE') setMessage('單一檔案不可超過 12 MiB。');
      else if (error instanceof PublicApiError && error.code === 'UNSUPPORTED_FILE') setMessage('只接受 JPEG、PNG 或非加密 PDF。');
      else if (error instanceof PublicApiError && error.code === 'INVALID_REQUEST') setMessage('檔案格式或大小不符合規定。');
      else setMessage('文件尚未上傳，請稍後重試。');
    } finally { setBusy(false); }
  }

  async function remove(documentId: string) {
    if (!caseId) return;
    setBusy(true); setMessage('');
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/documents?documentId=${encodeURIComponent(documentId)}`, { method: 'DELETE', ifMatch: `"${current.rowVersion}"` });
      setMessage('文件已移除。'); await load();
    } catch { setMessage('文件目前不能移除，請重新整理後再試。'); } finally { setBusy(false); }
  }

  async function correctField(field: DocumentFieldRecord) {
    const value = fieldEdits[field.id]?.trim();
    if (!caseId || !value) return;
    setBusy(true); setMessage('正在保存欄位修正…');
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/document-fields/${encodeURIComponent(field.id)}`, { method: 'PATCH', ifMatch: `"${current.rowVersion}"`, body: { value } });
      setMessage('欄位修正已保存。'); await load();
    } catch { setMessage('欄位修正未保存，請重新整理後再試。'); } finally { setBusy(false); }
  }

  if (!caseId) return <section className="document-review" aria-labelledby="documents-title"><h2 id="documents-title">附件</h2><p className="pending-note">建立申請草稿後，這裡會提供安全上傳入口。</p></section>;
  return <section className="document-review" aria-labelledby="documents-title">
    <h2 id="documents-title">附件</h2>
    <p className="field-hint">接受 JPEG、PNG 或非加密 PDF；單檔上限 12 MiB。系統會以檔案內容判斷格式，不以副檔名決定。</p>
    <p className="field-hint">OCR 只提供辨識草稿；每個欄位都會保留來源頁面、位置與原始值，請在送出前逐欄確認。</p>
    <dl className="document-rule-summary" aria-label="時間與補助狀態"><div><dt>申請時間</dt><dd>{evaluations.find((item) => item.evaluationKind === 'submission')?.outcome === 'pass' ? '符合' : evaluations.length ? '待確認' : '待確認'}</dd></div><div><dt>發票時間</dt><dd>{evaluations.find((item) => item.evaluationKind === 'invoice')?.outcome === 'pass' ? '已確認' : '待確認'}</dd></div><div><dt>購買期間</dt><dd>{evaluations.find((item) => item.evaluationKind === 'invoice' && item.outcome === 'pass') ? '符合' : evaluations.length ? '待確認' : '待規則檢查'}</dd></div><div><dt>預估補助</dt><dd>{evaluations.find((item) => item.evaluationKind === 'subsidy')?.outcome === 'pass' ? '已試算，最終以人工審核為準' : '待人工審核'}</dd></div></dl>
    {message && <p className="pending-note" role="status">{message}</p>}
    <div className="document-upload-form">
      <label htmlFor="document-kind">文件用途</label>
      <select id="document-kind" value={kind} onChange={(event) => setKind(event.target.value as DocumentKind)} disabled={busy}>
        <option value="invoice">發票或購買證明</option><option value="eligibility_proof">資格證明</option><option value="supplement">補件</option><option value="other">其他</option>
      </select>
      <label htmlFor="document-file">選擇檔案</label>
      <input id="document-file" type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} />
      {file && <p className="field-hint">{file.name} · {formatBytes(file.size)}</p>}
      <button type="button" onClick={() => void upload()} disabled={busy || !file}>{busy ? `上傳中 ${progress}%` : '上傳文件'}</button>
    </div>
    <ul className="document-list" aria-label="已上傳文件">
      {documents.map((document) => <li key={document.id}><span>{document.kind} · {document.mediaType} · {formatBytes(document.byteSize)}</span><span>{document.status === 'ready' ? '已保存' : document.status === 'deleted' ? '已移除' : '處理中'}</span>{document.status !== 'deleted' && caseState === 'draft' && <button type="button" onClick={() => void remove(document.id)} disabled={busy}>上傳前移除</button>}</li>)}
    </ul>
    {fields.length > 0 && <section aria-labelledby="ocr-fields-title"><h3 id="ocr-fields-title">OCR 欄位確認</h3><p className="field-hint">原始辨識值會保留；修正會新增一筆紀錄，不會覆寫歷史。</p><ul className="document-field-list">{fields.map((field) => <li key={field.id}><div><strong>{field.fieldName}</strong><span>原始：{field.originalValue ?? '待確認'} · 信心度：{field.confidence === null ? '—' : `${Math.round(field.confidence * 100)}%`}</span>{field.sourcePage !== null && <span>來源第 {field.sourcePage} 頁{field.sourceBox ? ' · 有位置資訊' : ''}</span>}</div><input aria-label={`${field.fieldName} 修正值`} value={fieldEdits[field.id] ?? field.effectiveValue ?? field.normalizedValue ?? ''} onChange={(event) => setFieldEdits((previous) => ({ ...previous, [field.id]: event.target.value }))} disabled={busy} /><button type="button" onClick={() => void correctField(field)} disabled={busy || !(fieldEdits[field.id] ?? '').trim()}>保存欄位修正</button></li>)}</ul></section>}
  </section>;
}
