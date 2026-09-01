'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DocumentRequirementKey } from '../../../shared/purchase-details-contract';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { formatTaipeiDate } from './applicant-case-status';

type DocumentKind = 'invoice' | 'eligibility_proof' | 'supplement' | 'other';

interface SupplementTask {
  id: string;
  taskType: string;
  title: string;
  instructions: string;
  acceptedDocumentTypes: string[];
  dueAt: string | null;
  createdAt: string;
  rowVersion: number;
}

interface DocumentRecord {
  id: string;
  kind: DocumentKind;
  requirementKey: DocumentRequirementKey | null;
  mediaType: string;
  byteSize: number;
  status: string;
  createdAt: string;
}

interface UploadSpec {
  kind: DocumentKind;
  requirementKey: DocumentRequirementKey;
  label: string;
  hint: string;
}

const MAX_BYTES = 12 * 1024 * 1024;
const ACCEPTED_FILES = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';
const FALLBACK_SPEC: UploadSpec = {
  kind: 'supplement',
  requirementKey: 'supplement_other',
  label: '補充文件',
  hint: '請依上方說明上傳完整、清楚的文件。',
};

const DIRECT_SPECS: Partial<Record<string, UploadSpec>> = {
  invoice: { kind: 'invoice', requirementKey: 'purchase_proof', label: '購買憑證或發票', hint: '文件需能清楚辨識購買資訊與金額。' },
  purchase_proof: { kind: 'invoice', requirementKey: 'purchase_proof', label: '購買憑證或發票', hint: '文件需能清楚辨識購買資訊與金額。' },
  eligibility_proof: { kind: 'eligibility_proof', requirementKey: 'special_status_proof', label: '資格證明', hint: '請上傳可清楚辨識身分或資格的證明。' },
  special_status_proof: { kind: 'eligibility_proof', requirementKey: 'special_status_proof', label: '資格證明', hint: '請上傳可清楚辨識身分或資格的證明。' },
  identity_front: { kind: 'eligibility_proof', requirementKey: 'identity_front', label: '身分證正面', hint: '照片需清楚、完整且沒有反光。' },
  identity_back: { kind: 'eligibility_proof', requirementKey: 'identity_back', label: '身分證反面', hint: '照片需清楚、完整且沒有反光。' },
  passbook_cover: { kind: 'supplement', requirementKey: 'passbook_cover', label: '存摺封面影本', hint: '需清楚顯示戶名與帳號。' },
  affidavit: { kind: 'other', requirementKey: 'affidavit', label: '切結書', hint: '請確認文件已簽名後再上傳。' },
  representative_affidavit: { kind: 'other', requirementKey: 'representative_affidavit', label: '代付切結書', hint: '請確認雙方已簽名後再上傳。' },
  supplement: FALLBACK_SPEC,
  other: FALLBACK_SPEC,
  supplement_other: FALLBACK_SPEC,
};

function resolveUploadSpec(task: SupplementTask): UploadSpec {
  for (const accepted of task.acceptedDocumentTypes) {
    const spec = DIRECT_SPECS[accepted];
    if (spec) return spec;
  }
  const request = `${task.title} ${task.instructions}`;
  if (/發票|購買憑證/.test(request)) return DIRECT_SPECS.invoice!;
  if (/身分證.*反面/.test(request)) return DIRECT_SPECS.identity_back!;
  if (/身分證/.test(request)) return DIRECT_SPECS.identity_front!;
  if (/存摺|帳戶/.test(request)) return DIRECT_SPECS.passbook_cover!;
  if (/代付.*切結/.test(request)) return DIRECT_SPECS.representative_affidavit!;
  if (/切結/.test(request)) return DIRECT_SPECS.affidavit!;
  if (/資格證明/.test(request)) return DIRECT_SPECS.eligibility_proof!;
  return FALLBACK_SPEC;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function SupplementPanel({ caseId, onCompleted }: { caseId: string; onCompleted: () => void | Promise<void> }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const [task, setTask] = useState<SupplementTask | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [taskResult, documentResult] = await Promise.all([
      api.read<{ tasks: SupplementTask[] }>(`/api/v1/tasks?caseId=${encodeURIComponent(caseId)}`),
      api.read<{ documents: DocumentRecord[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`),
    ]);
    setTask(taskResult.tasks.find((item) => item.taskType === 'provide_document') ?? null);
    setDocuments(documentResult.documents);
  }, [api, caseId]);

  useEffect(() => {
    let active = true;
    void load().catch(() => { if (active) setMessage('補件內容暫時無法載入，請稍後再試。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  const spec = task ? resolveUploadSpec(task) : FALLBACK_SPEC;
  const uploaded = task ? documents.find((document) => document.status === 'ready' && document.createdAt >= task.createdAt && document.requirementKey === spec.requirementKey) ?? null : null;

  async function upload(file: File | null) {
    if (!file || !task) return;
    if (file.size > MAX_BYTES) { setMessage('單一檔案不可超過 12 MiB。'); return; }
    setUploading(true); setUploadProgress(0); setMessage('');
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      await api.upload(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`, { file, kind: spec.kind, requirementKey: spec.requirementKey, ifMatch: `"${current.rowVersion}"`, onProgress: setUploadProgress });
      await load();
      setMessage('補件文件已上傳，確認後即可送出。');
    } catch (error) {
      if (error instanceof PublicApiError && error.code === 'FILE_TOO_LARGE') setMessage('單一檔案不可超過 12 MiB。');
      else if (error instanceof PublicApiError && error.code === 'UNSUPPORTED_FILE') setMessage('只接受 JPEG、PNG 或非加密 PDF。');
      else setMessage('文件尚未上傳，請重新選擇檔案。');
    } finally { setUploading(false); setUploadProgress(0); }
  }

  async function submit() {
    if (!task || !uploaded) return;
    setSubmitting(true); setMessage('');
    try {
      await api.mutate(`/api/v1/tasks/${encodeURIComponent(task.id)}/complete`, { method: 'POST', ifMatch: `"${task.rowVersion}"`, body: { action: 'provide_document' } });
      await onCompleted();
    } catch (error) {
      setMessage(error instanceof PublicApiError && error.code === 'INVALID_STATE' ? '請先上傳這次需要的補件文件。' : '補件尚未送出，請稍後再試。');
    } finally { setSubmitting(false); }
  }

  if (loading) return <section className="applicant-supplement" aria-label="補充資料"><p className="pending-note" role="status">正在載入補件說明…</p></section>;
  if (!task) return <section className="applicant-supplement applicant-supplement--error" aria-label="補充資料"><h2>補件內容暫時無法顯示</h2><p>請重新整理頁面；若仍無法顯示，請聯絡承辦人員。</p></section>;

  return (
    <section className="applicant-supplement" aria-labelledby="supplement-title">
      <header><p className="eyebrow">需要你的協助</p><h2 id="supplement-title">請補充資料</h2><p>審核人員需要以下文件，完成補件後會繼續審查。</p></header>
      <div className="applicant-supplement-request">
        <strong>{task.title}</strong>
        <p>{task.instructions}</p>
        {task.dueAt && <small>請於 {formatTaipeiDate(task.dueAt, true)} 前送出</small>}
      </div>
      {message && <p className="pending-note" role="status">{message}</p>}
      <div className={uploaded ? 'applicant-supplement-upload is-complete' : 'applicant-supplement-upload'}>
        <span className="attachment-check" aria-hidden="true">{uploaded ? '✓' : '1'}</span>
        <div><strong>{spec.label}</strong><p>{spec.hint}</p>{uploaded && <small>已上傳 · {formatBytes(uploaded.byteSize)}</small>}</div>
        <label className="file-picker-button">{uploading ? `上傳中 ${uploadProgress}%` : uploaded ? '重新上傳' : '選擇檔案'}<input type="file" accept={ACCEPTED_FILES} disabled={uploading || submitting} onChange={(event) => { const file = event.target.files?.[0] ?? null; event.currentTarget.value = ''; void upload(file); }} /></label>
      </div>
      <p className="field-hint">接受 JPEG、PNG 或非加密 PDF，單檔上限 12 MiB。</p>
      <button type="button" className="primary-action applicant-supplement-submit" disabled={!uploaded || uploading || submitting} onClick={() => void submit()}>{submitting ? '送出中…' : '送出補件'}</button>
    </section>
  );
}
