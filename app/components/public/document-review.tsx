'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PurchaseDetailsWriteSchema,
  PURCHASE_CURRENCIES,
  type DocumentRequirementKey,
  type PurchaseDetails,
} from '../../../shared/purchase-details-contract';
import { estimateConvertedTwd } from '../../../shared/fx-rates';
import {
  APPROVED_AI_TOOLS,
  approvedAiToolChoiceOptions,
  findApprovedAiTool,
  isBlockedAiToolLabel,
  type ApprovedAiTool,
} from '../../../shared/approved-ai-tools';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { ChoiceList } from './choice-list';
import {
  extractCardTransactionCandidates,
  extractVendorReceiptCandidates,
  type OcrLine,
} from '../../lib/ocr-field-extraction';

interface UploadWithOcr {
  document: DocumentRecord;
  ocr?: { lines: OcrLine[]; engineId: string; durationMs: number } | null;
}

/** Only string-valued draft fields the OCR extractors ever populate (see suggestionsFromOcr). */
type SuggestibleField = 'invoiceNumber' | 'purchaseDate' | 'originalCurrency' | 'originalExpense' | 'receiptBuyerName' | 'convertedTwd';

interface FieldSuggestion {
  field: SuggestibleField;
  label: string;
  value: string;
}

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
  softwareToolId: string;
  softwareName: string;
  companyName: string;
  purchaseDate: string;
  payerType: 'self_card' | 'representative';
  originalCurrency: 'TWD' | 'USD' | 'JPY' | 'EUR' | 'AUD' | 'HKD' | 'OTHER';
  otherCurrency: string;
  originalExpense: string;
  convertedTwd: string;
  specialStatus: boolean;
  invoiceNumber: string;
  cardLastFour: string;
  cardholderName: string;
  paymentSourceRegistered: boolean;
  // 新增訂閱區間欄位
  subscriptionStartDate: string;
  subscriptionEndDate: string;
  applicantName: string;
  receiptBuyerName: string;
  birthDate: string;
}

type PublicPurchaseDetails = Omit<PurchaseDetails, 'paymentSourceFingerprint'> & {
  paymentSourceRegistered?: boolean;
};

interface RequirementSpec {
  key: DocumentRequirementKey;
  kind: DocumentKind;
  label: string;
  hint: string;
  required: boolean;
}

const MAX_BYTES = 12 * 1024 * 1024;
const ACCEPTED_FILES = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';

const FIELD_LABELS: Record<string, string> = {
  softwareName: '軟體名稱',
  companyName: '軟體公司名稱',
  purchaseDate: '購買日期',
  billingPeriods: '月費期數',
  otherFunction: '其他功能名稱',
  otherCurrency: '其他幣別',
  originalExpense: '原始費用',
  convertedTwd: '換算新臺幣',
  cardLastFour: '信用卡末四碼',
  cardholderName: '持卡人姓名',
  invoiceNumber: '發票號碼',
  // 新增訂閱區間欄位標籤
  subscriptionStartDate: '訂閱開始日',
  subscriptionEndDate: '訂閱結束日',
  applicantName: '申請人姓名',
  receiptBuyerName: '收據買受人姓名',
  birthDate: '出生日期',
};

const ERROR_MESSAGES: Record<string, string> = {
  FILE_TOO_LARGE: '單一檔案大小上限為 12 MB。',
  IMAGE_TOO_LARGE: '圖片解析度過大，請壓縮或轉為 JPG 後上傳。',
  FILE_UNREADABLE: '檔案無法讀取或已損毀，請重新存檔後上傳。',
  FILE_ENCRYPTED: '此 PDF 已加密，請上傳未加密版本。',
  FILE_TOO_MANY_PAGES: 'PDF 文件超過 10 頁，請精簡後上傳。',
  UNSUPPORTED_FILE: '僅支援 JPG、PNG、PDF 格式，請轉檔後上傳。',
};

const EMPTY_DETAILS: PurchaseDetailsDraft = {
  billingCycle: 'annual', billingPeriods: '', softwareFunction: 'general', otherFunction: '',
  softwareToolId: '', softwareName: '', companyName: '', purchaseDate: '', payerType: 'self_card',
  originalCurrency: 'TWD', otherCurrency: '', originalExpense: '', convertedTwd: '',
  specialStatus: false, invoiceNumber: '', cardLastFour: '', cardholderName: '', paymentSourceRegistered: false,
  // 新增訂閱區間欄位
  subscriptionStartDate: '',
  subscriptionEndDate: '',
  applicantName: '',
  receiptBuyerName: '',
  birthDate: '',
};

const SOFTWARE_OPTIONS = approvedAiToolChoiceOptions();

function toolIdForName(name: string): string {
  const match = findApprovedAiTool(name);
  return match?.id ?? (name ? '__other__' : '');
}

function draftForApprovedTool(tool: ApprovedAiTool | null | undefined): PurchaseDetailsDraft {
  if (!tool) return EMPTY_DETAILS;
  return {
    ...EMPTY_DETAILS,
    softwareToolId: tool.id,
    softwareName: tool.label,
    companyName: tool.company,
  };
}

const REQUIREMENTS: Record<DocumentRequirementKey, RequirementSpec> = {
  identity_front: { key: 'identity_front', kind: 'eligibility_proof', label: '身分證正面', hint: '照片需清晰完整，避免反光。', required: true },
  identity_back: { key: 'identity_back', kind: 'eligibility_proof', label: '身分證反面', hint: '照片需清晰完整，避免反光。', required: true },
  special_status_proof: { key: 'special_status_proof', kind: 'eligibility_proof', label: '資格證明', hint: '請上傳可辨識身分之有效證明。', required: true },
  purchase_proof: { key: 'purchase_proof', kind: 'invoice', label: '購買憑證或發票', hint: '需包含購買人、軟體名稱、日期、期間、金額與付款方式。', required: true },
  vendor_receipt: { key: 'vendor_receipt', kind: 'invoice', label: '官方收據', hint: '國外電子收據或訂閱確認信截圖，需包含品項、原幣金額、日期與買受人姓名。', required: true },
  card_transaction: { key: 'card_transaction', kind: 'invoice', label: '刷卡單筆明細', hint: '銀行 App 中該筆交易的明細截圖，需包含實付台幣金額、持卡人與交易日。請只截取這一筆交易，其他消費請遮蔽。', required: true },
  passbook_cover: { key: 'passbook_cover', kind: 'supplement', label: '存摺封面影本', hint: '需包含完整戶名與帳號。', required: true },
  affidavit: { key: 'affidavit', kind: 'other', label: '切結書', hint: '申請人親筆簽名後拍照或掃描上傳（可於官網或 LINE 選單下載範本）。', required: true },
  representative_affidavit: { key: 'representative_affidavit', kind: 'other', label: '代付切結書', hint: '由父母、配偶或法定代理人代付時，需雙方簽名後拍照或掃描上傳。', required: true },
  supplement_other: { key: 'supplement_other', kind: 'supplement', label: '其他補充文件', hint: '依審核人員指示上傳補充文件。', required: true },
};

function draftFromDetails(details: PublicPurchaseDetails): PurchaseDetailsDraft {
  return {
    billingCycle: details.billingCycle,
    billingPeriods: details.billingPeriods === null ? '' : String(details.billingPeriods),
    softwareFunction: details.softwareFunction,
    otherFunction: details.otherFunction ?? '',
    softwareToolId: toolIdForName(details.softwareName),
    softwareName: details.softwareName,
    companyName: details.companyName,
    purchaseDate: details.purchaseDate,
    payerType: details.payerType,
    originalCurrency: details.originalCurrency,
    otherCurrency: details.originalCurrency === 'OTHER' ? (details.otherCurrency ?? '') : '',
    originalExpense: details.originalExpense,
    convertedTwd: String(details.convertedTwd),
    specialStatus: details.specialStatus,
    invoiceNumber: details.invoiceNumber ?? '',
    cardLastFour: '',
    cardholderName: '',
    paymentSourceRegistered: Boolean(details.paymentSourceRegistered),
    // 新增訂閱區間欄位
    subscriptionStartDate: details.subscriptionStartDate ?? '',
    subscriptionEndDate: details.subscriptionEndDate ?? '',
    applicantName: details.applicantName ?? '',
    receiptBuyerName: details.receiptBuyerName ?? '',
    birthDate: details.birthDate ?? '',
  };
}

function parseDraft(draft: PurchaseDetailsDraft) {
  const keepExisting = draft.paymentSourceRegistered && !draft.cardLastFour && !draft.cardholderName;
  const convertedTwd = draft.originalCurrency === 'TWD'
    ? Math.round(Number(draft.originalExpense))
    : Number(draft.convertedTwd);
  return PurchaseDetailsWriteSchema.safeParse({
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
    convertedTwd,
    specialStatus: draft.specialStatus,
    invoiceNumber: draft.invoiceNumber.trim() ? draft.invoiceNumber.trim() : null,
    cardLastFour: draft.cardLastFour.trim() ? draft.cardLastFour.trim() : null,
    cardholderName: draft.cardholderName.trim() ? draft.cardholderName.trim() : null,
    subscriptionStartDate: draft.subscriptionStartDate.trim() || null,
    subscriptionEndDate: draft.subscriptionEndDate.trim() || null,
    applicantName: draft.applicantName.trim() || null,
    receiptBuyerName: draft.receiptBuyerName.trim() || null,
    birthDate: draft.birthDate.trim() || null,
    keepExistingPaymentSource: keepExisting || undefined,
  });
}

function publicComparable(details: {
  billingCycle: string;
  billingPeriods: number | null;
  softwareFunction: string;
  otherFunction: string | null;
  softwareName: string;
  companyName: string;
  purchaseDate: string;
  payerType: string;
  originalCurrency: string;
  otherCurrency: string | null;
  originalExpense: string;
  convertedTwd: number;
  specialStatus: boolean;
  invoiceNumber: string | null;
  // 新增訂閱區間欄位
  subscriptionStartDate: string | null;
  subscriptionEndDate: string | null;
  applicantName: string | null;
  receiptBuyerName: string | null;
  birthDate: string | null;
}): string {
  return JSON.stringify({
    billingCycle: details.billingCycle,
    billingPeriods: details.billingPeriods,
    softwareFunction: details.softwareFunction,
    otherFunction: details.otherFunction,
    softwareName: details.softwareName,
    companyName: details.companyName,
    purchaseDate: details.purchaseDate,
    payerType: details.payerType,
    originalCurrency: details.originalCurrency,
    otherCurrency: details.otherCurrency,
    originalExpense: details.originalExpense,
    convertedTwd: details.convertedTwd,
    specialStatus: details.specialStatus,
    invoiceNumber: details.invoiceNumber,
    // 新增訂閱區間欄位
    subscriptionStartDate: details.subscriptionStartDate,
    subscriptionEndDate: details.subscriptionEndDate,
    applicantName: details.applicantName,
    receiptBuyerName: details.receiptBuyerName,
    birthDate: details.birthDate,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentReview({ suppliedCaseId, onSubmit, submitting = false, prefilledTool }: {
  suppliedCaseId?: string;
  onSubmit?: () => void;
  submitting?: boolean;
  prefilledTool?: ApprovedAiTool | null;
} = {}) {
  const caseId = suppliedCaseId ?? null;
  const api = useMemo(() => new PublicApiClient(), []);
  const [draft, setDraft] = useState<PurchaseDetailsDraft>(() => draftForApprovedTool(prefilledTool));
  const [savedDetails, setSavedDetails] = useState<PublicPurchaseDetails | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyRequirements, setBusyRequirements] = useState<Set<DocumentRequirementKey>>(new Set());
  const [progressByRequirement, setProgressByRequirement] = useState<Partial<Record<DocumentRequirementKey, number>>>({});
  const [caseEtag, setCaseEtag] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<'purchase' | 'attachments'>('purchase');
  const [pendingFilePreview, setPendingFilePreview] = useState<Partial<Record<DocumentRequirementKey, { name: string; size: number }>>>({});
  const [ocrSuggestions, setOcrSuggestions] = useState<Partial<Record<DocumentRequirementKey, FieldSuggestion[]>>>({});

  const parsedDraft = useMemo(() => parseDraft(draft), [draft]);
  const detailsSaved = Boolean(
    parsedDraft.success
    && savedDetails
    && publicComparable(savedDetails) === publicComparable(parsedDraft.data)
    && !parsedDraft.data.cardLastFour
    && !parsedDraft.data.cardholderName,
  );
  const visibleSpecs = useMemo(() => [
    REQUIREMENTS.identity_front,
    REQUIREMENTS.identity_back,
    ...(draft.specialStatus ? [REQUIREMENTS.special_status_proof] : []),
    REQUIREMENTS.vendor_receipt,
    REQUIREMENTS.card_transaction,
    REQUIREMENTS.passbook_cover,
    REQUIREMENTS.affidavit,
    ...(draft.payerType === 'representative' ? [REQUIREMENTS.representative_affidavit] : []),
  ], [draft.payerType, draft.specialStatus]);
  const requiredSpecs = useMemo(() => visibleSpecs.filter((spec) => spec.required), [visibleSpecs]);
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
        api.read<{ details: PublicPurchaseDetails | null }>(`/api/v1/cases/${encodeURIComponent(caseId)}/purchase-details`),
        api.read<{ documents: DocumentRecord[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/documents`),
        api.readWithMeta<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`),
      ]).then(([detailsResult, documentResult, caseResult]) => {
        if (!active) return;
        setSavedDetails(detailsResult.details);
        if (detailsResult.details) {
          setDraft(draftFromDetails(detailsResult.details));
          const hasSubscription = Boolean(
            detailsResult.details.subscriptionStartDate && detailsResult.details.subscriptionEndDate,
          );
          if (hasSubscription) {
            setStep('attachments');
          } else {
            setStep('purchase');
            setMessage('請補填訂閱起迄日後，再儲存購買資料。');
          }
        }
        setDocuments(documentResult.documents);
        setCaseEtag(caseResult.etag ?? null);
        if (detailsResult.details?.subscriptionStartDate && detailsResult.details?.subscriptionEndDate) {
          setMessage('');
        }
      }).catch(() => {
        if (active) setMessage('附件暫時無法載入，請稍後再試。');
      }).finally(() => {
        if (active) setLoading(false);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, caseId]);

  function updateDraft<K extends keyof PurchaseDetailsDraft>(key: K, value: PurchaseDetailsDraft[K]) {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === 'originalCurrency' || key === 'originalExpense' || key === 'otherCurrency') {
        if (next.originalCurrency === 'TWD') {
          const estimate = estimateConvertedTwd({
            originalCurrency: next.originalCurrency,
            otherCurrency: next.otherCurrency || null,
            originalExpense: next.originalExpense,
          });
          if (estimate.estimatedTwd != null) next.convertedTwd = String(estimate.estimatedTwd);
        }
      }
      return next;
    });
    setConfirmed(false);
    setMessage('');
  }

  async function saveDetails() {
    if (!caseId) return;
    if (isBlockedAiToolLabel(draft.softwareName) || isBlockedAiToolLabel(draft.companyName)) {
      setMessage('本補助不適用中港澳開發之 AI 工具，請更換選項。');
      return;
    }
    const parsed = parseDraft(draft);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (!key || nextErrors[key]) continue;
        // TWD hides the converted field; the original-expense error already tells the applicant what to fix.
        if (key === 'convertedTwd' && draft.originalCurrency === 'TWD') continue;
        const label = FIELD_LABELS[key] ?? key;
        nextErrors[key] = issue.message && /[一-鿿]/.test(issue.message) ? issue.message : `請確認${label}`;
      }
      if (Object.keys(nextErrors).length === 0) nextErrors.form = '請完成所有必填之購買資料。';
      setFieldErrors(nextErrors);
      setMessage(`請修正下列欄位後再儲存：${Object.entries(nextErrors).map(([key, text]) => `${FIELD_LABELS[key] ?? key}（${text}）`).join('、')}`);
      const firstKey = Object.keys(nextErrors)[0];
      window.setTimeout(() => {
        const target = document.querySelector<HTMLElement>(`[data-field="${firstKey}"], [name="${firstKey}"]`);
        target?.focus();
      }, 0);
      return;
    }
    setFieldErrors({});
    setSaving(true); setMessage('');
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      const result = await api.mutate<{ details: PublicPurchaseDetails }>(`/api/v1/cases/${encodeURIComponent(caseId)}/purchase-details`, { method: 'PUT', ifMatch: `"${current.rowVersion}"`, body: parsed.data });
      setSavedDetails(result.details);
      setDraft(draftFromDetails(result.details));
      const refreshed = await api.readWithMeta<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      setCaseEtag(refreshed.etag ?? null);
      setMessage('購買資料已儲存。');
      setStep('attachments');
    } catch (error) {
      setMessage(error instanceof PublicApiError && error.code === 'ETAG_MISMATCH' ? '資料已更新，請重新儲存。' : '購買資料儲存失敗，請稍後再試。');
    } finally { setSaving(false); }
  }

  function isHeic(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith('.heic') || name.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
  }

  async function ensureCaseEtag(): Promise<string> {
    if (caseEtag) return caseEtag;
    const refreshed = await api.readWithMeta<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId!)}`);
    const etag = refreshed.etag ?? `"${refreshed.data.rowVersion}"`;
    setCaseEtag(etag);
    return etag;
  }

  function markBusy(key: DocumentRequirementKey, busy: boolean) {
    setBusyRequirements((previous) => {
      const next = new Set(previous);
      if (busy) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function uploadDocument(spec: RequirementSpec, file: File, etag: string): Promise<UploadWithOcr> {
    return api.upload<UploadWithOcr>(`/api/v1/cases/${encodeURIComponent(caseId!)}/documents`, {
      file, kind: spec.kind, requirementKey: spec.key, ifMatch: etag,
      onProgress: (percent) => setProgressByRequirement((previous) => ({ ...previous, [spec.key]: percent })),
    });
  }

  function applySuggestion(suggestion: FieldSuggestion) {
    // suggestionsFromOcr only ever emits (field, value) pairs it has already
    // validated against the field's real type (e.g. originalCurrency is
    // checked against PURCHASE_CURRENCIES there), so this narrow cast is safe.
    updateDraft(suggestion.field, suggestion.value as never);
    setOcrSuggestions((previous) => {
      const next = { ...previous };
      for (const key of Object.keys(next) as DocumentRequirementKey[]) {
        next[key] = next[key]?.filter((item) => item.field !== suggestion.field);
      }
      return next;
    });
  }

  function suggestionsFromOcr(requirementKey: DocumentRequirementKey, lines: OcrLine[]): FieldSuggestion[] {
    if (requirementKey === 'vendor_receipt') {
      const candidates = extractVendorReceiptCandidates(lines);
      const suggestions: FieldSuggestion[] = [];
      if (candidates.invoiceNumber) suggestions.push({ field: 'invoiceNumber', label: '發票號碼', value: candidates.invoiceNumber });
      if (candidates.purchaseDate) suggestions.push({ field: 'purchaseDate', label: '購買日期', value: candidates.purchaseDate });
      if (candidates.originalCurrency && (PURCHASE_CURRENCIES as readonly string[]).includes(candidates.originalCurrency)) {
        suggestions.push({ field: 'originalCurrency', label: '原始費用幣別', value: candidates.originalCurrency });
      }
      if (candidates.originalExpense) suggestions.push({ field: 'originalExpense', label: '原始費用', value: candidates.originalExpense });
      if (candidates.receiptBuyerName) suggestions.push({ field: 'receiptBuyerName', label: '官方收據上的買受人姓名', value: candidates.receiptBuyerName });
      return suggestions;
    }
    if (requirementKey === 'card_transaction') {
      const candidates = extractCardTransactionCandidates(lines);
      return candidates.convertedTwd ? [{ field: 'convertedTwd', label: '換算新臺幣', value: String(candidates.convertedTwd) }] : [];
    }
    return [];
  }

  async function upload(spec: RequirementSpec, file: File | null) {
    if (!caseId || !file) return;
    if (file.size > MAX_BYTES) { setMessage('單一檔案大小上限為 12 MB。'); return; }
    if (isHeic(file)) { setMessage('不支援 HEIC 格式。請改用 JPG、PNG 或 PDF 上傳。'); return; }
    setPendingFilePreview((previous) => ({ ...previous, [spec.key]: { name: file.name, size: file.size } }));
    setConfirmed(false);
    markBusy(spec.key, true);
    setProgressByRequirement((previous) => ({ ...previous, [spec.key]: 0 }));
    setMessage('');
    try {
      let etag = await ensureCaseEtag();
      let uploaded: UploadWithOcr;
      try {
        uploaded = await uploadDocument(spec, file, etag);
      } catch (error) {
        if (error instanceof PublicApiError && error.code === 'ETAG_MISMATCH') {
          const refreshed = await api.readWithMeta<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
          etag = refreshed.etag ?? `"${refreshed.data.rowVersion}"`;
          setCaseEtag(etag);
          uploaded = await uploadDocument(spec, file, etag);
        } else { throw error; }
      }
      await loadDocuments();
      const suggestions = uploaded.ocr?.lines ? suggestionsFromOcr(spec.key, uploaded.ocr.lines) : [];
      setOcrSuggestions((previous) => ({ ...previous, [spec.key]: suggestions }));
      setMessage(`${spec.label}已上傳（${file.name} · ${formatBytes(file.size)}）。`);
    } catch (error) {
      const code = error instanceof PublicApiError ? error.code : null;
      setMessage(code && ERROR_MESSAGES[code] ? ERROR_MESSAGES[code] : `${spec.label}上傳失敗，請重新選擇檔案。`);
    } finally {
      markBusy(spec.key, false);
      setProgressByRequirement((previous) => { const next = { ...previous }; delete next[spec.key]; return next; });
    }
  }

  async function remove(document: DocumentRecord, label: string) {
    if (!caseId) return;
    const key = document.requirementKey ?? 'supplement_other';
    markBusy(key, true); setConfirmed(false); setMessage('');
    try {
      let etag = await ensureCaseEtag();
      try {
        await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/documents?documentId=${encodeURIComponent(document.id)}`, { method: 'DELETE', ifMatch: etag });
      } catch (error) {
        if (error instanceof PublicApiError && error.code === 'ETAG_MISMATCH') {
          const refreshed = await api.readWithMeta<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
          etag = refreshed.etag ?? `"${refreshed.data.rowVersion}"`;
          setCaseEtag(etag);
          await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/documents?documentId=${encodeURIComponent(document.id)}`, { method: 'DELETE', ifMatch: etag });
        } else { throw error; }
      }
      await loadDocuments();
      setMessage(`${label}已移除。`);
    } catch { setMessage('檔案暫時無法移除，請稍後再試。'); } finally { markBusy(key, false); }
  }

  if (!caseId) return null;
  if (loading) return <p className="pending-note" role="status">附件載入中…</p>;

  return (
    <section className="document-review attachment-step" aria-labelledby="documents-title">
      <header className="attachment-step-header">
        <p className="eyebrow">第 2 部分</p>
        <h2 id="documents-title">購買資料與附件</h2>
        <p>完成購買資料與附件上傳後即可送出。</p>
        <div className="attachment-step-tabs" role="tablist" aria-label="附件流程">
          <button type="button" role="tab" aria-selected={step === 'purchase'} className={step === 'purchase' ? 'is-current' : undefined} onClick={() => setStep('purchase')}>1. 購買資料</button>
          <button type="button" role="tab" aria-selected={step === 'attachments'} className={step === 'attachments' ? 'is-current' : undefined} onClick={() => setStep('attachments')} disabled={!detailsSaved && step !== 'attachments'}>2. 附件上傳</button>
        </div>
      </header>
      {message && <p className="pending-note attachment-message" role="status">{message}</p>}
      {Object.keys(fieldErrors).length > 0 && (
        <div className="form-error-summary" role="alert">
          <strong>請修正下列欄位後再儲存</strong>
          <ul>
            {Object.entries(fieldErrors).map(([key, text]) => (
              <li key={key}><button type="button" className="text-action" onClick={() => document.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus()}>{FIELD_LABELS[key] ?? key}：{text}</button></li>
            ))}
          </ul>
        </div>
      )}

      {step === 'purchase' && (
      <section className="attachment-section-card" aria-labelledby="purchase-details-title">
        <div className="attachment-section-heading"><div><span>1</span><h3 id="purchase-details-title">填寫購買資料</h3></div><strong className={detailsSaved ? 'attachment-status is-complete' : 'attachment-status'}>{detailsSaved ? '已儲存' : '尚未完成'}</strong></div>
        <form className="purchase-details-form" onSubmit={(event) => { event.preventDefault(); void saveDetails(); }} noValidate>
          <label>申請人姓名 <span aria-hidden="true">＊</span><input data-field="applicantName" value={draft.applicantName} maxLength={100} autoComplete="name" aria-invalid={Boolean(fieldErrors.applicantName)} placeholder="例如：陳大文" onChange={(event) => updateDraft('applicantName', event.target.value)} /><small>請填寫與身分證件一致的姓名。</small>{fieldErrors.applicantName && <p className="field-error" role="alert">{fieldErrors.applicantName}</p>}</label>
          <label>出生日期<input data-field="birthDate" type="date" value={draft.birthDate} aria-invalid={Boolean(fieldErrors.birthDate)} onChange={(event) => updateDraft('birthDate', event.target.value)} /><small>用於確認本方案的年齡資格。</small>{fieldErrors.birthDate && <p className="field-error" role="alert">{fieldErrors.birthDate}</p>}</label>
          <fieldset><legend>繳費制度 <span aria-hidden="true">＊</span></legend><div className="choice-row"><label><input type="radio" name="billing-cycle" checked={draft.billingCycle === 'annual'} onChange={() => updateDraft('billingCycle', 'annual')} />年費制</label><label><input type="radio" name="billing-cycle" checked={draft.billingCycle === 'monthly'} onChange={() => updateDraft('billingCycle', 'monthly')} />月費制</label></div>{draft.billingCycle === 'monthly' && <label className="inline-number-field">共 <input aria-label="月費期數" data-field="billingPeriods" type="number" min="1" max="120" inputMode="numeric" value={draft.billingPeriods} aria-invalid={Boolean(fieldErrors.billingPeriods)} onChange={(event) => updateDraft('billingPeriods', event.target.value)} /> 期</label>}{fieldErrors.billingPeriods && <p className="field-error" role="alert">{fieldErrors.billingPeriods}</p>}</fieldset>
          <fieldset><legend>軟體功能 <span aria-hidden="true">＊</span></legend><div className="choice-grid">{([['general', '通用型'], ['imaging', '影像類'], ['office', '辦公類'], ['learning', '學習類'], ['other', '其他']] as const).map(([value, label]) => <label key={value}><input type="radio" name="software-function" checked={draft.softwareFunction === value} onChange={() => updateDraft('softwareFunction', value)} />{label}</label>)}</div>{draft.softwareFunction === 'other' && <label>其他功能名稱<input data-field="otherFunction" value={draft.otherFunction} maxLength={100} aria-invalid={Boolean(fieldErrors.otherFunction)} onChange={(event) => updateDraft('otherFunction', event.target.value)} /></label>}{fieldErrors.otherFunction && <p className="field-error" role="alert">{fieldErrors.otherFunction}</p>}</fieldset>
          <div className="purchase-field-grid purchase-field-grid--tool">
            <div data-field="softwareName">
              <ChoiceList
                label="軟體名稱 ＊"
                options={SOFTWARE_OPTIONS}
                value={draft.softwareToolId}
                required
                searchable
                searchPlaceholder="輸入名稱搜尋，或直接點選分類清單"
                otherValue={draft.softwareToolId === '__other__' ? draft.softwareName : ''}
                otherPlaceholder="請填寫工具名稱（不適用中港澳工具）"
                onChange={(value) => {
                  if (value === '__other__') {
                    setDraft((current) => ({ ...current, softwareToolId: value, softwareName: '', companyName: current.companyName }));
                  } else {
                    const tool = APPROVED_AI_TOOLS.find((item) => item.id === value) ?? findApprovedAiTool(value);
                    setDraft((current) => ({
                      ...current,
                      softwareToolId: tool?.id ?? value,
                      softwareName: tool?.label ?? '',
                      companyName: tool?.company ?? current.companyName,
                    }));
                  }
                  setConfirmed(false);
                  setMessage('');
                  setFieldErrors((current) => { const next = { ...current }; delete next.softwareName; return next; });
                }}
                onOtherChange={(value) => {
                  setDraft((current) => ({ ...current, softwareToolId: '__other__', softwareName: value }));
                  setConfirmed(false);
                  setMessage('');
                }}
              />
              {fieldErrors.softwareName && <p className="field-error" role="alert">{fieldErrors.softwareName}</p>}
            </div>
            <label>軟體公司名稱 <span aria-hidden="true">＊</span><input data-field="companyName" value={draft.companyName} maxLength={200} autoComplete="organization" aria-invalid={Boolean(fieldErrors.companyName)} onChange={(event) => updateDraft('companyName', event.target.value)} />{fieldErrors.companyName && <p className="field-error" role="alert">{fieldErrors.companyName}</p>}</label>
            <label>購買日期 <span aria-hidden="true">＊</span><input data-field="purchaseDate" type="date" value={draft.purchaseDate} aria-invalid={Boolean(fieldErrors.purchaseDate)} onChange={(event) => updateDraft('purchaseDate', event.target.value)} />{fieldErrors.purchaseDate && <p className="field-error" role="alert">{fieldErrors.purchaseDate}</p>}</label>
          <label>發票號碼<input data-field="invoiceNumber" value={draft.invoiceNumber} maxLength={40} autoComplete="off" placeholder="選填，有助於加速核對發票或收據" onChange={(event) => updateDraft('invoiceNumber', event.target.value)} /></label>
        </div>
        <fieldset><legend>付款人 <span aria-hidden="true">＊</span></legend><div className="choice-stack"><label><input type="radio" name="payer" checked={draft.payerType === 'self_card'} onChange={() => updateDraft('payerType', 'self_card')} />本人信用卡</label><label><input type="radio" name="payer" checked={draft.payerType === 'representative'} onChange={() => updateDraft('payerType', 'representative')} />父母、配偶或法定代理人代付</label></div></fieldset>
        <aside className="sensitive-data-note" aria-labelledby="card-privacy-title">
          <h4 id="card-privacy-title">信用卡資訊用途與安全說明</h4>
          <p>為核對購買真實性並防範重複請領，系統僅加密比對卡號末四碼與持卡人姓名，絕不留存完整卡號明文或安全碼。</p>
        </aside>
        <label>官方收據上的買受人姓名 <span aria-hidden="true">＊</span><input data-field="receiptBuyerName" value={draft.receiptBuyerName} maxLength={100} aria-invalid={Boolean(fieldErrors.receiptBuyerName)} placeholder="請照抄收據上顯示的姓名" onChange={(event) => updateDraft('receiptBuyerName', event.target.value)} /><small>請填寫「官方收據」文件上列出的買受人姓名，用於核對是否與申請人或代付人一致。</small>{fieldErrors.receiptBuyerName && <p className="field-error" role="alert">{fieldErrors.receiptBuyerName}</p>}</label>
        <div className="purchase-field-grid"><label>信用卡末四碼 <span aria-hidden="true">＊</span><input data-field="cardLastFour" value={draft.cardLastFour} inputMode="numeric" maxLength={4} autoComplete="off" aria-invalid={Boolean(fieldErrors.cardLastFour)} placeholder={draft.paymentSourceRegistered ? '已登記（可留空）' : '例如 1234'} onChange={(event) => updateDraft('cardLastFour', event.target.value.replace(/\D/g, '').slice(0, 4))} /><small>{draft.paymentSourceRegistered ? '已登記付款卡號資訊，若未變更可留空。' : '僅用於防重複請領檢核。系統不保留明文。'}</small>{fieldErrors.cardLastFour && <p className="field-error" role="alert">{fieldErrors.cardLastFour}</p>}</label><label>持卡人姓名 <span aria-hidden="true">＊</span><input data-field="cardholderName" value={draft.cardholderName} maxLength={100} autoComplete="cc-name" aria-invalid={Boolean(fieldErrors.cardholderName)} placeholder={draft.paymentSourceRegistered ? '已登記（可留空）' : '須與卡片一致'} onChange={(event) => updateDraft('cardholderName', event.target.value)} />{fieldErrors.cardholderName && <p className="field-error" role="alert">{fieldErrors.cardholderName}</p>}</label></div>
        <fieldset><legend>原始費用幣別 <span aria-hidden="true">＊</span></legend><div className="choice-grid currency-choices">{([['TWD', '新臺幣'], ['USD', '美金'], ['JPY', '日圓'], ['EUR', '歐元'], ['AUD', '澳幣'], ['HKD', '港幣'], ['OTHER', '其他']] as const).map(([value, label]) => <label key={value}><input type="radio" name="currency" checked={draft.originalCurrency === value} onChange={() => updateDraft('originalCurrency', value)} />{label}</label>)}</div>{draft.originalCurrency === 'OTHER' && <label>其他幣別<input data-field="otherCurrency" value={draft.otherCurrency} maxLength={24} onChange={(event) => updateDraft('otherCurrency', event.target.value)} /></label>}</fieldset>
        <div className="purchase-field-grid"><label>原始費用 <span aria-hidden="true">＊</span><input data-field="originalExpense" type="text" inputMode="decimal" placeholder="例如 29.99" value={draft.originalExpense} aria-invalid={Boolean(fieldErrors.originalExpense)} onChange={(event) => updateDraft('originalExpense', event.target.value)} />{fieldErrors.originalExpense && <p className="field-error" role="alert">{fieldErrors.originalExpense}</p>}</label>{draft.originalCurrency === 'TWD' ? (
          <p className="field-hint" data-field="convertedTwd">幣別為新臺幣，系統已自動為您帶入換算金額{draft.convertedTwd ? `（NT$${Number(draft.convertedTwd).toLocaleString('zh-TW')}）` : ''}，無需另外計算。</p>
        ) : (
          <label>換算新臺幣 <span aria-hidden="true">＊</span><input data-field="convertedTwd" type="number" min="1" max="100000000" inputMode="numeric" placeholder="請填寫整數" value={draft.convertedTwd} aria-invalid={Boolean(fieldErrors.convertedTwd)} onChange={(event) => updateDraft('convertedTwd', event.target.value)} />{(() => { const estimate = estimateConvertedTwd({ originalCurrency: draft.originalCurrency, otherCurrency: draft.otherCurrency || null, originalExpense: draft.originalExpense }); return estimate.estimatedTwd != null ? <small>參考試算約 NT${estimate.estimatedTwd.toLocaleString('zh-TW')}（匯率 {estimate.referenceRate}）</small> : null; })()}{fieldErrors.convertedTwd && <p className="field-error" role="alert">{fieldErrors.convertedTwd}</p>}</label>
        )}</div>
        <fieldset><legend>訂閱開始日 <span aria-hidden="true">＊</span></legend><input data-field="subscriptionStartDate" type="date" value={draft.subscriptionStartDate} aria-invalid={Boolean(fieldErrors.subscriptionStartDate)} onChange={(event) => updateDraft('subscriptionStartDate', event.target.value)} /><small>請依發票或訂閱憑證標示之啟用日填寫。</small>{fieldErrors.subscriptionStartDate && <p className="field-error" role="alert">{fieldErrors.subscriptionStartDate}</p>}</fieldset>
        <fieldset><legend>訂閱結束日 <span aria-hidden="true">＊</span></legend><input data-field="subscriptionEndDate" type="date" value={draft.subscriptionEndDate} aria-invalid={Boolean(fieldErrors.subscriptionEndDate)} onChange={(event) => updateDraft('subscriptionEndDate', event.target.value)} /><small>請依發票或訂閱憑證標示之到期日填寫。</small>{fieldErrors.subscriptionEndDate && <p className="field-error" role="alert">{fieldErrors.subscriptionEndDate}</p>}</fieldset>
        <fieldset><legend>資格證明</legend><label className="checkbox-card"><input type="checkbox" checked={draft.specialStatus} onChange={(event) => updateDraft('specialStatus', event.target.checked)} /><span><strong>具備特定對象或文化語言保存者身分</strong><small>若具備相關身分，請勾選並於下一步上傳證明文件。</small></span></label></fieldset>
          <div className="wizard-actions">
            {detailsSaved ? (
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  setStep('attachments');
                  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                前往附件上傳
              </button>
            ) : (
              <button type="submit" className="primary-action" disabled={saving}>
                {saving ? '儲存中…' : '儲存並前往附件'}
              </button>
            )}
          </div>
        </form>
      </section>
      )}

      {step === 'attachments' && (
      <>
      <section className="attachment-section-card" aria-labelledby="required-files-title">
        <div className="attachment-section-heading"><div><span>2</span><h3 id="required-files-title">上傳必備文件</h3></div><strong className="attachment-progress">{completedCount} / {requiredSpecs.length}</strong></div>
        <aside className="sensitive-data-note" aria-labelledby="docs-privacy-title">
          <h4 id="docs-privacy-title">個人證件與存摺隱私保護</h4>
          <p>您上傳的個人證件與存摺封面均以專屬金鑰加密存放，僅供本計畫審核使用，並依規定安全銷毀。</p>
        </aside>
        <p className="field-hint">支援 JPEG、PNG 或未加密之 PDF。單一檔案上限 12 MB。不支援 HEIC 格式（如使用 iPhone 請設定為相容格式 JPG）。</p>
        <div className="attachment-requirement-list">
          {visibleSpecs.map((spec) => {
            const document = latestDocument(spec.key); const isBusy = busyRequirements.has(spec.key); const isReady = document?.status === 'ready';
            const preview = pendingFilePreview[spec.key];
            const progress = progressByRequirement[spec.key];
            const suggestions = ocrSuggestions[spec.key];
            return <article className={isReady ? 'attachment-requirement is-complete' : 'attachment-requirement'} key={spec.key}>
              <div className="attachment-requirement-copy"><span className="attachment-check" aria-hidden="true">{isReady ? '✓' : spec.required ? requiredSpecs.indexOf(spec) + 1 : '－'}</span><div><h4>{spec.label}<em>{spec.required ? '必備' : '選填'}</em></h4><p>{spec.hint}</p>{document && <small>{isReady ? `已上傳 · ${formatBytes(document.byteSize)}` : '檔案處理中'}</small>}{preview && isBusy && <small>已選取：{preview.name} · {formatBytes(preview.size)}</small>}{typeof progress === 'number' && isBusy && <progress max={100} value={progress} aria-label={`${spec.label}上傳進度`}>{progress}%</progress>}</div></div>
              <div className="attachment-requirement-actions"><label className="file-picker-button">{isBusy ? `上傳中 ${progress ?? 0}%` : document ? '重新上傳' : '選擇檔案'}<input type="file" accept={ACCEPTED_FILES} disabled={isBusy || submitting} onChange={(event) => { const selected = event.target.files?.[0] ?? null; event.currentTarget.value = ''; void upload(spec, selected); }} /></label>{document && <button type="button" className="text-action" disabled={isBusy || submitting} onClick={() => void remove(document, spec.label)}>移除</button>}</div>
              {suggestions && suggestions.length > 0 && (
                <aside className="ocr-suggestion-panel" aria-label={`${spec.label}辨識結果`}>
                  <p>系統從{spec.label}偵測到以下資訊，確認無誤後可套用到購買資料：</p>
                  <ul>
                    {suggestions.map((suggestion) => (
                      <li key={suggestion.field}>
                        <span>{suggestion.label}：{suggestion.value}</span>
                        <button type="button" className="text-action" onClick={() => applySuggestion(suggestion)}>套用</button>
                      </li>
                    ))}
                  </ul>
                </aside>
              )}
            </article>;
          })}
        </div>
        <button type="button" className="secondary-action" onClick={() => setStep('purchase')}>返回購買資料</button>
      </section>

      <section className="attachment-submit-card" aria-labelledby="formal-submit-title">
        <h3 id="formal-submit-title">送出申請</h3>
        {!detailsSaved && (
          <p role="status">
            {draft.subscriptionStartDate && draft.subscriptionEndDate
              ? '請先儲存購買資料。'
              : '請先補齊並儲存購買資料（含訂閱起迄日）。'}
          </p>
        )}
        {detailsSaved && completedCount < requiredSpecs.length && (
          <p role="status">尚有 {requiredSpecs.length - completedCount} 項必備文件未上傳。</p>
        )}
        {readyToSubmit && (
          <label className="final-confirmation">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>購買資料與附件內容皆確認無誤。</span>
          </label>
        )}
        <button
          type="button"
          className="primary-action"
          disabled={!readyToSubmit || !confirmed || submitting || busyRequirements.size > 0}
          onClick={onSubmit}
        >
          {submitting ? '申請送出中…' : '送出申請'}
        </button>
      </section>
      </>
      )}
    </section>
  );
}
