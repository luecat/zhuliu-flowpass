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
const ACCEPTED_FILES = '.jpg,.jpeg,.png,.pdf,.heic,.heif,image/jpeg,image/png,application/pdf';

const ERROR_MESSAGES: Record<string, string> = {
  FILE_TOO_LARGE: '單一檔案大小上限為 12 MB。',
  IMAGE_TOO_LARGE: '圖片解析度過大，請壓縮或轉為 JPG 後上傳。',
  FILE_UNREADABLE: '檔案無法讀取或已損毀，請重新存檔後上傳。',
  FILE_ENCRYPTED: '此 PDF 已加密，請上傳未加密版本。',
  FILE_TOO_MANY_PAGES: 'PDF 文件超過 10 頁，請精簡後上傳。',
  UNSUPPORTED_FILE: '僅支援 JPG、PNG、PDF 格式，請轉檔後上傳。',
};
const FALLBACK_SPEC: UploadSpec = {
  kind: 'supplement',
  requirementKey: 'supplement_other',
  label: '補充文件',
  hint: '請依指示上傳清晰完整之文件。',
};

const DIRECT_SPECS: Partial<Record<string, UploadSpec>> = {
  invoice: { kind: 'invoice', requirementKey: 'purchase_proof', label: '購買憑證或發票', hint: '文件需能清楚辨識購買資訊與金額。' },
  purchase_proof: { kind: 'invoice', requirementKey: 'purchase_proof', label: '購買憑證或發票', hint: '文件需能清楚辨識購買資訊與金額。' },
  eligibility_proof: { kind: 'eligibility_proof', requirementKey: 'special_status_proof', label: '資格證明', hint: '請上傳可清楚辨識身分或資格的證明。' },
  special_status_proof: { kind: 'eligibility_proof', requirementKey: 'special_status_proof', label: '資格證明', hint: '請上傳可清楚辨識身分或資格的證明。' },
  identity_front: { kind: 'eligibility_proof', requirementKey: 'identity_front', label: '身分證正面', hint: '照片需清晰完整，避免反光。' },
  identity_back: { kind: 'eligibility_proof', requirementKey: 'identity_back', label: '身分證反面', hint: '照片需清晰完整，避免反光。' },
  passbook_cover: { kind: 'supplement', requirementKey: 'passbook_cover', label: '存摺封面影本', hint: '需包含完整戶名與帳號。' },
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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [caseEtag, setCaseEtag] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [taskResult, documentResult, caseResult] = await Promise.all([
      api.read<{ tasks: SupplementTask[] }>(`/api/v1/tasks?caseId=${encodeURIComponent(caseId)}`),
      api.read<{ documents: DocumentRecord[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`),
      api.readWithMeta<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`),
    ]);
    setTask(taskResult.tasks.find((item) => item.taskType === 'provide_document') ?? null);
    setDocuments(documentResult.documents);
    setCaseEtag(caseResult.etag ?? null);
  }, [api, caseId]);

  useEffect(() => {
    let active = true;
    void load().catch(() => { if (active) setMessage('補件內容暫時無法載入，請稍後再試。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  const spec = task ? resolveUploadSpec(task) : FALLBACK_SPEC;
  const uploaded = task ? documents.find((document) => document.status === 'ready' && document.createdAt >= task.createdAt && document.requirementKey === spec.requirementKey) ?? null : null;

  function isHeic(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith('.heic') || name.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
  }

  async function ensureCaseEtag(): Promise<string> {
    if (caseEtag) return caseEtag;
    const refreshed = await api.readWithMeta<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
    const etag = refreshed.etag ?? `"${refreshed.data.rowVersion}"`;
    setCaseEtag(etag);
    return etag;
  }

  async function upload(file: File | null) {
    if (!file || !task) return;
    if (file.size > MAX_BYTES) { setMessage('單一檔案大小上限為 12 MB。'); return; }
    if (isHeic(file)) { setMessage('不支援 HEIC 格式。請轉為 JPG、PNG 或 PDF 後上傳。'); return; }
    setUploading(true); setUploadProgress(0); setMessage('');
    try {
      let etag = await ensureCaseEtag();
      try {
        await api.upload(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`, { file, kind: spec.kind, requirementKey: spec.requirementKey, ifMatch: etag, onProgress: setUploadProgress });
      } catch (error) {
        if (error instanceof PublicApiError && error.code === 'ETAG_MISMATCH') {
          const refreshed = await api.readWithMeta<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
          etag = refreshed.etag ?? `"${refreshed.data.rowVersion}"`;
          setCaseEtag(etag);
          await api.upload(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`, { file, kind: spec.kind, requirementKey: spec.requirementKey, ifMatch: etag, onProgress: setUploadProgress });
        } else { throw error; }
      }
      await load();
      setMessage('補件文件已上傳，確認後即可送出。');
    } catch (error) {
      const code = error instanceof PublicApiError ? error.code : null;
      setMessage(code && ERROR_MESSAGES[code] ? ERROR_MESSAGES[code] : '文件尚未上傳，請重新選擇檔案。');
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
      <p className="field-hint">支援 JPEG、PNG 或未加密之 PDF。單一檔案上限 12 MB。不支援 HEIC 格式。</p>
      <button type="button" className="primary-action applicant-supplement-submit" disabled={!uploaded || uploading || submitting} onClick={() => void submit()}>{submitting ? '送出中…' : '送出補件'}</button>
    </section>
  );
}
