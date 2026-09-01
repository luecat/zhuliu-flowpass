'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PurchaseDetailsSchema,
  type DocumentRequirementKey,
  type PurchaseDetails,
} from '../../../shared/purchase-details-contract';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';

type DocumentKind = 'invoice' | 'eligibility_proof' | 'supplement' | 'other';

interface DocumentRecord {
  id: string;
  kind: DocumentKind;
  requirementKey: DocumentRequirementKey | null;
  mediaType: string;
  byteSize: number;
  status: string;
  rowVersion: number;
}

interface PurchaseDetailsDraft {
  billingCycle: 'annual' | 'monthly';
  billingPeriods: string;
  softwareFunction: 'general' | 'imaging' | 'office' | 'learning' | 'other';
  otherFunction: string;
  softwareName: string;
  companyName: string;
  purchaseDate: string;
  payerType: 'self_card' | 'representative';
  originalCurrency: 'TWD' | 'USD' | 'JPY' | 'EUR' | 'AUD' | 'HKD' | 'OTHER';
  otherCurrency: string;
  originalExpense: string;
  convertedTwd: string;
  specialStatus: boolean;
}

interface RequirementSpec {
  key: DocumentRequirementKey;
  kind: DocumentKind;
  label: string;
  hint: string;
}

const MAX_BYTES = 12 * 1024 * 1024;
const ACCEPTED_FILES = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';

const EMPTY_DETAILS: PurchaseDetailsDraft = {
  billingCycle: 'annual', billingPeriods: '', softwareFunction: 'general', otherFunction: '',
  softwareName: '', companyName: '', purchaseDate: '', payerType: 'self_card',
  originalCurrency: 'TWD', otherCurrency: '', originalExpense: '', convertedTwd: '',
  specialStatus: false,
};

const REQUIREMENTS: Record<DocumentRequirementKey, RequirementSpec> = {
  identity_front: { key: 'identity_front', kind: 'eligibility_proof', label: '身分證正面', hint: '照片需清楚、完整且沒有反光。' },
  identity_back: { key: 'identity_back', kind: 'eligibility_proof', label: '身分證反面', hint: '照片需清楚、完整且沒有反光。' },
  special_status_proof: { key: 'special_status_proof', kind: 'eligibility_proof', label: '特定對象或文化語言保存者證明', hint: '請上傳可辨識身分或資格的有效證明。' },
  purchase_proof: { key: 'purchase_proof', kind: 'invoice', label: '購買憑證或發票', hint: '需看得到購買人、軟體名稱、日期、期間、金額與付款方式。' },
  passbook_cover: { key: 'passbook_cover', kind: 'supplement', label: '存摺封面影本', hint: '需看得到戶名與帳號，內容請保持完整。' },
  affidavit: { key: 'affidavit', kind: 'other', label: '切結書', hint: '請由申請人親筆簽名後拍照或掃描上傳。' },
  representative_affidavit: { key: 'representative_affidavit', kind: 'other', label: '代付切結書', hint: '由父母、配偶或法定代理人代付時，需要雙方簽名。' },
  supplement_other: { key: 'supplement_other', kind: 'supplement', label: '其他補充文件', hint: '請依審核人員的說明上傳完整文件。' },
};

function draftFromDetails(details: PurchaseDetails): PurchaseDetailsDraft {
  return {
    ...details,
    billingPeriods: details.billingPeriods === null ? '' : String(details.billingPeriods),
    otherFunction: details.otherFunction ?? '',
    otherCurrency: details.otherCurrency ?? '',
    convertedTwd: String(details.convertedTwd),
  };
}

function parseDraft(draft: PurchaseDetailsDraft) {
  return PurchaseDetailsSchema.safeParse({
    billingCycle: draft.billingCycle,
    billingPeriods: draft.billingCycle === 'annual' ? null : Number(draft.billingPeriods),
    softwareFunction: draft.softwareFunction,
    otherFunction: draft.softwareFunction === 'other' ? draft.otherFunction : null,
    softwareName: draft.softwareName,
    companyName: draft.companyName,
    purchaseDate: draft.purchaseDate,
    payerType: draft.payerType,
    originalCurrency: draft.originalCurrency,
    otherCurrency: draft.originalCurrency === 'OTHER' ? draft.otherCurrency : null,
    originalExpense: draft.originalExpense,
    convertedTwd: Number(draft.convertedTwd),
    specialStatus: draft.specialStatus,
  });
}

function sameDetails(left: PurchaseDetails | null, right: PurchaseDetails): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function DocumentReview({ suppliedCaseId, onSubmit, submitting = false }: {
  suppliedCaseId?: string;
  onSubmit?: () => void;
  submitting?: boolean;
} = {}) {
  const caseId = suppliedCaseId ?? null;
  const api = useMemo(() => new PublicApiClient(), []);
  const [draft, setDraft] = useState<PurchaseDetailsDraft>(EMPTY_DETAILS);
  const [savedDetails, setSavedDetails] = useState<PurchaseDetails | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeRequirement, setActiveRequirement] = useState<DocumentRequirementKey | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');

  const parsedDraft = useMemo(() => parseDraft(draft), [draft]);
  const detailsSaved = parsedDraft.success && sameDetails(savedDetails, parsedDraft.data);
  const requiredSpecs = useMemo(() => [
    REQUIREMENTS.identity_front,
    REQUIREMENTS.identity_back,
    ...(draft.specialStatus ? [REQUIREMENTS.special_status_proof] : []),
    REQUIREMENTS.purchase_proof,
    REQUIREMENTS.passbook_cover,
    REQUIREMENTS.affidavit,
    ...(draft.payerType === 'representative' ? [REQUIREMENTS.representative_affidavit] : []),
  ], [draft.payerType, draft.specialStatus]);
  const latestDocument = useCallback((requirementKey: DocumentRequirementKey) => (
    documents.find((document) => document.requirementKey === requirementKey && document.status !== 'deleted') ?? null
  ), [documents]);
  const completedCount = requiredSpecs.filter((spec) => latestDocument(spec.key)?.status === 'ready').length;
  const readyToSubmit = detailsSaved && completedCount === requiredSpecs.length;

  const loadDocuments = useCallback(async () => {
    if (!caseId) return;
    const result = await api.read<{ documents: DocumentRecord[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`);
    setDocuments(result.documents);
  }, [api, caseId]);

  useEffect(() => {
    if (!caseId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void Promise.all([
        api.read<{ details: PurchaseDetails | null }>(`/api/v1/cases/${encodeURIComponent(caseId)}/purchase-details`),
        api.read<{ documents: DocumentRecord[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`),
      ]).then(([detailsResult, documentResult]) => {
        if (!active) return;
        setSavedDetails(detailsResult.details);
        if (detailsResult.details) setDraft(draftFromDetails(detailsResult.details));
        setDocuments(documentResult.documents);
        setMessage('');
      }).catch(() => {
        if (active) setMessage('附件資料暫時無法載入，請稍後再試。');
      }).finally(() => {
        if (active) setLoading(false);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, caseId]);

  function updateDraft<K extends keyof PurchaseDetailsDraft>(key: K, value: PurchaseDetailsDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setConfirmed(false);
    setMessage('');
  }

  async function saveDetails() {
    if (!caseId) return;
    const parsed = parseDraft(draft);
    if (!parsed.success) { setMessage('請先完成所有必填的購買資料。'); return; }
    setSaving(true); setMessage('');
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      const result = await api.mutate<{ details: PurchaseDetails }>(`/api/v1/cases/${encodeURIComponent(caseId)}/purchase-details`, { method: 'PUT', ifMatch: `"${current.rowVersion}"`, body: parsed.data });
      setSavedDetails(result.details);
      setDraft(draftFromDetails(result.details));
      setMessage('購買資料已儲存。');
    } catch (error) {
      setMessage(error instanceof PublicApiError && error.code === 'ETAG_MISMATCH' ? '資料剛剛有更新，請再儲存一次。' : '購買資料尚未儲存，請稍後再試。');
    } finally { setSaving(false); }
  }

  async function upload(spec: RequirementSpec, file: File | null) {
    if (!caseId || !file) return;
    if (file.size > MAX_BYTES) { setMessage('單一檔案不可超過 12 MiB。'); return; }
    setActiveRequirement(spec.key); setUploadProgress(0); setMessage('');
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      await api.upload(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`, { file, kind: spec.kind, requirementKey: spec.key, ifMatch: `"${current.rowVersion}"`, onProgress: setUploadProgress });
      await loadDocuments();
      setMessage(`${spec.label}已上傳。`);
    } catch (error) {
      if (error instanceof PublicApiError && error.code === 'FILE_TOO_LARGE') setMessage('單一檔案不可超過 12 MiB。');
      else if (error instanceof PublicApiError && error.code === 'UNSUPPORTED_FILE') setMessage('只接受 JPEG、PNG 或非加密 PDF。');
      else setMessage(`${spec.label}尚未上傳，請重新選擇檔案。`);
    } finally { setActiveRequirement(null); setUploadProgress(0); }
  }

  async function remove(document: DocumentRecord, label: string) {
    if (!caseId) return;
    setActiveRequirement(document.requirementKey); setConfirmed(false); setMessage('');
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/documents?documentId=${encodeURIComponent(document.id)}`, { method: 'DELETE', ifMatch: `"${current.rowVersion}"` });
      await loadDocuments();
      setMessage(`${label}已移除。`);
    } catch { setMessage('檔案目前無法移除，請稍後再試。'); } finally { setActiveRequirement(null); }
  }

  if (!caseId) return null;
  if (loading) return <p className="pending-note" role="status">正在載入附件資料…</p>;

  return (
    <section className="document-review attachment-step" aria-labelledby="documents-title">
      <header className="attachment-step-header">
        <p className="eyebrow">第 2 部分</p>
        <h2 id="documents-title">購買資料與附件</h2>
        <p>先填寫購買資料，再逐項上傳文件。完成後即可正式送出申請。</p>
      </header>
      {message && <p className="pending-note attachment-message" role="status">{message}</p>}

      <section className="attachment-section-card" aria-labelledby="purchase-details-title">
        <div className="attachment-section-heading"><div><span>1</span><h3 id="purchase-details-title">填寫購買資料</h3></div><strong className={detailsSaved ? 'attachment-status is-complete' : 'attachment-status'}>{detailsSaved ? '已儲存' : '尚未完成'}</strong></div>
        <form className="purchase-details-form" onSubmit={(event) => { event.preventDefault(); void saveDetails(); }}>
          <fieldset><legend>繳費制度 <span aria-hidden="true">＊</span></legend><div className="choice-row"><label><input type="radio" name="billing-cycle" checked={draft.billingCycle === 'annual'} onChange={() => updateDraft('billingCycle', 'annual')} />年費制</label><label><input type="radio" name="billing-cycle" checked={draft.billingCycle === 'monthly'} onChange={() => updateDraft('billingCycle', 'monthly')} />月費制</label></div>{draft.billingCycle === 'monthly' && <label className="inline-number-field">共 <input aria-label="月費期數" type="number" min="1" max="120" inputMode="numeric" value={draft.billingPeriods} onChange={(event) => updateDraft('billingPeriods', event.target.value)} /> 期</label>}</fieldset>
          <fieldset><legend>軟體功能 <span aria-hidden="true">＊</span></legend><div className="choice-grid">{([['general', '通用型'], ['imaging', '影像類'], ['office', '辦公類'], ['learning', '學習類'], ['other', '其他類']] as const).map(([value, label]) => <label key={value}><input type="radio" name="software-function" checked={draft.softwareFunction === value} onChange={() => updateDraft('softwareFunction', value)} />{label}</label>)}</div>{draft.softwareFunction === 'other' && <label>其他功能名稱<input value={draft.otherFunction} maxLength={100} onChange={(event) => updateDraft('otherFunction', event.target.value)} /></label>}</fieldset>
          <div className="purchase-field-grid"><label>軟體名稱 <span aria-hidden="true">＊</span><input value={draft.softwareName} maxLength={200} autoComplete="off" onChange={(event) => updateDraft('softwareName', event.target.value)} /></label><label>軟體公司名稱 <span aria-hidden="true">＊</span><input value={draft.companyName} maxLength={200} autoComplete="organization" onChange={(event) => updateDraft('companyName', event.target.value)} /></label><label>購買日期 <span aria-hidden="true">＊</span><input type="date" value={draft.purchaseDate} onChange={(event) => updateDraft('purchaseDate', event.target.value)} /></label></div>
          <fieldset><legend>付款人 <span aria-hidden="true">＊</span></legend><div className="choice-stack"><label><input type="radio" name="payer" checked={draft.payerType === 'self_card'} onChange={() => updateDraft('payerType', 'self_card')} />本人信用卡</label><label><input type="radio" name="payer" checked={draft.payerType === 'representative'} onChange={() => updateDraft('payerType', 'representative')} />父母、配偶或法定代理人代付</label></div></fieldset>
          <fieldset><legend>原始費用幣別 <span aria-hidden="true">＊</span></legend><div className="choice-grid currency-choices">{([['TWD', '新臺幣'], ['USD', '美金'], ['JPY', '日圓'], ['EUR', '歐元'], ['AUD', '澳幣'], ['HKD', '港幣'], ['OTHER', '其他']] as const).map(([value, label]) => <label key={value}><input type="radio" name="currency" checked={draft.originalCurrency === value} onChange={() => updateDraft('originalCurrency', value)} />{label}</label>)}</div>{draft.originalCurrency === 'OTHER' && <label>其他幣別<input value={draft.otherCurrency} maxLength={24} onChange={(event) => updateDraft('otherCurrency', event.target.value)} /></label>}</fieldset>
          <div className="purchase-field-grid"><label>原始費用 <span aria-hidden="true">＊</span><input type="text" inputMode="decimal" placeholder="例如 29.99" value={draft.originalExpense} onChange={(event) => updateDraft('originalExpense', event.target.value)} /></label><label>換算新臺幣 <span aria-hidden="true">＊</span><input type="number" min="1" max="100000000" inputMode="numeric" placeholder="請填整數" value={draft.convertedTwd} onChange={(event) => updateDraft('convertedTwd', event.target.value)} /></label></div>
          <fieldset><legend>資格證明</legend><label className="checkbox-card"><input type="checkbox" checked={draft.specialStatus} onChange={(event) => updateDraft('specialStatus', event.target.checked)} /><span><strong>我是特定對象或文化語言保存者</strong><small>勾選後，需要再上傳相關資格證明。</small></span></label></fieldset>
          <button type="submit" className="secondary-action" disabled={saving || detailsSaved}>{saving ? '儲存中…' : detailsSaved ? '購買資料已儲存' : '儲存購買資料'}</button>
        </form>
      </section>

      <section className="attachment-section-card" aria-labelledby="required-files-title">
        <div className="attachment-section-heading"><div><span>2</span><h3 id="required-files-title">上傳必要文件</h3></div><strong className="attachment-progress">{completedCount} / {requiredSpecs.length}</strong></div>
        <p className="field-hint">接受 JPEG、PNG 或非加密 PDF，單檔上限 12 MiB。</p>
        <div className="attachment-requirement-list">
          {requiredSpecs.map((spec, index) => {
            const document = latestDocument(spec.key); const isBusy = activeRequirement === spec.key; const isReady = document?.status === 'ready';
            return <article className={isReady ? 'attachment-requirement is-complete' : 'attachment-requirement'} key={spec.key}><div className="attachment-requirement-copy"><span className="attachment-check" aria-hidden="true">{isReady ? '✓' : index + 1}</span><div><h4>{spec.label}<em>必要</em></h4><p>{spec.hint}</p>{document && <small>{isReady ? `已上傳 · ${formatBytes(document.byteSize)}` : '檔案處理中'}</small>}</div></div><div className="attachment-requirement-actions"><label className="file-picker-button">{isBusy ? `上傳中 ${uploadProgress}%` : document ? '重新上傳' : '選擇檔案'}<input type="file" accept={ACCEPTED_FILES} disabled={activeRequirement !== null || submitting} onChange={(event) => { const selected = event.target.files?.[0] ?? null; event.currentTarget.value = ''; void upload(spec, selected); }} /></label>{document && <button type="button" className="text-action" disabled={activeRequirement !== null || submitting} onClick={() => void remove(document, spec.label)}>移除</button>}</div></article>;
          })}
        </div>
      </section>

      <section className="attachment-submit-card" aria-labelledby="formal-submit-title">
        <h3 id="formal-submit-title">正式送出</h3>
        {!detailsSaved && <p>請先儲存完整的購買資料。</p>}
        {detailsSaved && completedCount < requiredSpecs.length && <p>還有 {requiredSpecs.length - completedCount} 項必要文件尚未上傳。</p>}
        {readyToSubmit && <label className="final-confirmation"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已確認購買資料與附件內容正確。</span></label>}
        <button type="button" className="primary-action" disabled={!readyToSubmit || !confirmed || submitting || activeRequirement !== null} onClick={onSubmit}>{submitting ? '正式送出中…' : '正式送出申請'}</button>
      </section>
    </section>
  );
}
