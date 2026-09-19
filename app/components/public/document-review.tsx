'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { DocumentOcrResponseData } from '../../../shared/ocr-contract';

interface UploadWithOcr {
  document: DocumentRecord;
  ocr?: { lines: OcrLine[]; engineId: string; durationMs: number } | null;
}

type OcrFillableField = 'invoiceNumber' | 'purchaseDate' | 'originalCurrency' | 'originalExpense' | 'receiptBuyerName' | 'convertedTwd' | 'billingCycle' | 'softwareName' | 'companyName' | 'subscriptionStartDate' | 'subscriptionEndDate';

interface FieldSuggestion {
  field: OcrFillableField;
  label: string;
  value: string;
}

type Page1GapField =
  | 'applicantName'
  | 'billingCycle'
  | 'billingPeriods'
  | 'softwareFunction'
  | 'otherFunction'
  | 'softwareName'
  | 'companyName'
  | 'purchaseDate'
  | 'receiptBuyerName'
  | 'originalCurrency'
  | 'otherCurrency'
  | 'originalExpense'
  | 'convertedTwd'
  | 'subscriptionStartDate'
  | 'subscriptionEndDate';

type ReviewStep = 'ocr' | 'payment' | 'attachments';

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
  billingCycle: 'annual' | 'monthly' | '';
  billingPeriods: string;
  softwareFunction: 'general' | 'imaging' | 'office' | 'learning' | 'other' | '';
  otherFunction: string;
  softwareToolId: string;
  softwareName: string;
  companyName: string;
  purchaseDate: string;
  payerType: 'self_card' | 'representative';
  originalCurrency: 'TWD' | 'USD' | 'JPY' | 'EUR' | 'AUD' | 'HKD' | 'OTHER' | '';
  otherCurrency: string;
  originalExpense: string;
  convertedTwd: string;
  specialStatus: boolean;
  invoiceNumber: string;
  cardLastFour: string;
  cardholderName: string;
  paymentSourceRegistered: boolean;
  subscriptionStartDate: string;
  subscriptionEndDate: string;
  applicantName: string;
  receiptBuyerName: string;
  birthDate: string;
  nationalId: string;
  householdAddress: string;
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
  billingCycle: '繳費制度',
  billingPeriods: '月費期數',
  softwareFunction: '軟體功能',
  otherFunction: '其他功能名稱',
  otherCurrency: '其他幣別',
  originalCurrency: '原始費用幣別',
  originalExpense: '原始費用',
  convertedTwd: '銀行付款實付台幣',
  cardLastFour: '信用卡末四碼',
  cardholderName: '持卡人姓名',
  invoiceNumber: '發票號碼',
  subscriptionStartDate: '訂閱開始日',
  subscriptionEndDate: '訂閱結束日',
  applicantName: '申請人姓名',
  receiptBuyerName: '收據買受人姓名',
  birthDate: '出生日期',
  nationalId: '身分證字號',
  householdAddress: '戶籍地址',
};

const SOFTWARE_FUNCTION_LABELS: Record<Exclude<PurchaseDetailsDraft['softwareFunction'], ''>, string> = {
  general: '通用型',
  imaging: '影像類',
  office: '辦公類',
  learning: '學習類',
  other: '其他',
};

const CURRENCY_LABELS: Record<Exclude<PurchaseDetailsDraft['originalCurrency'], ''>, string> = {
  TWD: '新臺幣',
  USD: '美金',
  JPY: '日圓',
  EUR: '歐元',
  AUD: '澳幣',
  HKD: '港幣',
  OTHER: '其他',
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
  billingCycle: '', billingPeriods: '', softwareFunction: '', otherFunction: '',
  softwareToolId: '', softwareName: '', companyName: '', purchaseDate: '', payerType: 'self_card',
  originalCurrency: '', otherCurrency: '', originalExpense: '', convertedTwd: '',
  specialStatus: false, invoiceNumber: '', cardLastFour: '', cardholderName: '', paymentSourceRegistered: false,
  subscriptionStartDate: '',
  subscriptionEndDate: '',
  applicantName: '',
  receiptBuyerName: '',
  birthDate: '',
  nationalId: '',
  householdAddress: '',
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

const OCR_ELIGIBLE_REQUIREMENTS: ReadonlySet<DocumentRequirementKey> = new Set(['vendor_receipt', 'card_transaction']);
const OCR_SPECS: RequirementSpec[] = [REQUIREMENTS.vendor_receipt, REQUIREMENTS.card_transaction];

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
    subscriptionStartDate: details.subscriptionStartDate ?? '',
    subscriptionEndDate: details.subscriptionEndDate ?? '',
    applicantName: details.applicantName ?? '',
    receiptBuyerName: details.receiptBuyerName ?? '',
    birthDate: details.birthDate ?? '',
    nationalId: details.nationalId ?? '',
    householdAddress: details.householdAddress ?? '',
  };
}

function parseDraft(draft: PurchaseDetailsDraft, options: { deferPaymentSource?: boolean } = {}) {
  const keepExisting = draft.paymentSourceRegistered && !draft.cardLastFour && !draft.cardholderName;
  const convertedTwd = Number(draft.convertedTwd);
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
    nationalId: draft.nationalId.trim() || null,
    householdAddress: draft.householdAddress.trim() || null,
    keepExistingPaymentSource: options.deferPaymentSource ? undefined : (keepExisting || undefined),
    deferPaymentSource: options.deferPaymentSource || undefined,
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
  subscriptionStartDate: string | null;
  subscriptionEndDate: string | null;
  applicantName: string | null;
  receiptBuyerName: string | null;
  birthDate: string | null;
  nationalId: string | null;
  householdAddress: string | null;
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
    subscriptionStartDate: details.subscriptionStartDate,
    subscriptionEndDate: details.subscriptionEndDate,
    applicantName: details.applicantName,
    receiptBuyerName: details.receiptBuyerName,
    birthDate: details.birthDate,
    nationalId: details.nationalId,
    householdAddress: details.householdAddress,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function page1MissingFields(draft: PurchaseDetailsDraft): Page1GapField[] {
  const missing: Page1GapField[] = [];
  if (!draft.applicantName.trim()) missing.push('applicantName');
  if (!draft.billingCycle) missing.push('billingCycle');
  if (draft.billingCycle === 'monthly' && !draft.billingPeriods.trim()) missing.push('billingPeriods');
  if (!draft.softwareFunction) missing.push('softwareFunction');
  if (draft.softwareFunction === 'other' && !draft.otherFunction.trim()) missing.push('otherFunction');
  if (!draft.softwareName.trim()) missing.push('softwareName');
  if (!draft.companyName.trim()) missing.push('companyName');
  if (!draft.purchaseDate) missing.push('purchaseDate');
  if (!draft.receiptBuyerName.trim()) missing.push('receiptBuyerName');
  if (!draft.originalCurrency) missing.push('originalCurrency');
  if (draft.originalCurrency === 'OTHER' && !draft.otherCurrency.trim()) missing.push('otherCurrency');
  if (!draft.originalExpense.trim()) missing.push('originalExpense');
  if (!draft.convertedTwd.trim()) missing.push('convertedTwd');
  if (!draft.subscriptionStartDate) missing.push('subscriptionStartDate');
  if (!draft.subscriptionEndDate) missing.push('subscriptionEndDate');
  return missing;
}

function amountsDisagree(draft: PurchaseDetailsDraft): boolean {
  const estimate = estimateConvertedTwd({
    originalCurrency: draft.originalCurrency || 'OTHER',
    otherCurrency: draft.otherCurrency || null,
    originalExpense: draft.originalExpense,
  });
  if (estimate.estimatedTwd == null || !draft.convertedTwd.trim()) return false;
  const paid = Number(draft.convertedTwd);
  if (!Number.isFinite(paid)) return false;
  if (draft.originalCurrency === 'TWD') return paid !== estimate.estimatedTwd;
  const lowerBound = estimate.estimatedTwd - Math.max(1, Math.round(estimate.estimatedTwd * 0.05));
  return paid < lowerBound;
}

/** Editable page-1 fields stay visible after fill so applicants can review and correct them. */
function page1EditableFields(draft: PurchaseDetailsDraft): Page1GapField[] {
  const fields: Page1GapField[] = [
    'applicantName',
    'billingCycle',
  ];
  if (draft.billingCycle === 'monthly') fields.push('billingPeriods');
  fields.push('softwareFunction');
  if (draft.softwareFunction === 'other') fields.push('otherFunction');
  fields.push(
    'softwareName',
    'companyName',
    'purchaseDate',
    'receiptBuyerName',
    'originalCurrency',
  );
  if (draft.originalCurrency === 'OTHER') fields.push('otherCurrency');
  fields.push('originalExpense', 'convertedTwd', 'subscriptionStartDate', 'subscriptionEndDate');
  return fields;
}

function displayFilledValue(draft: PurchaseDetailsDraft, field: string): string | null {
  switch (field) {
    case 'applicantName': return draft.applicantName.trim() || null;
    case 'billingCycle': return draft.billingCycle === 'annual' ? '年費制' : draft.billingCycle === 'monthly' ? `月費制${draft.billingPeriods ? ` ${draft.billingPeriods} 期` : ''}` : null;
    case 'softwareFunction': return draft.softwareFunction ? SOFTWARE_FUNCTION_LABELS[draft.softwareFunction] : null;
    case 'softwareName': return draft.softwareName.trim() || null;
    case 'companyName': return draft.companyName.trim() || null;
    case 'purchaseDate': return draft.purchaseDate || null;
    case 'invoiceNumber': return draft.invoiceNumber.trim() || null;
    case 'receiptBuyerName': return draft.receiptBuyerName.trim() || null;
    case 'originalCurrency': return draft.originalCurrency ? CURRENCY_LABELS[draft.originalCurrency] : null;
    case 'originalExpense': return draft.originalExpense.trim() || null;
    case 'convertedTwd': return draft.convertedTwd.trim() ? `NT$${Number(draft.convertedTwd).toLocaleString('zh-TW')}` : null;
    case 'subscriptionStartDate': return draft.subscriptionStartDate || null;
    case 'subscriptionEndDate': return draft.subscriptionEndDate || null;
    default: return null;
  }
}

const FILLED_SUMMARY_FIELDS = [
  'softwareName', 'companyName', 'billingCycle', 'softwareFunction', 'purchaseDate',
  'invoiceNumber', 'receiptBuyerName', 'originalCurrency', 'originalExpense', 'convertedTwd',
  'subscriptionStartDate', 'subscriptionEndDate', 'applicantName',
] as const;

function page1FilledEntries(draft: PurchaseDetailsDraft): Array<{ field: string; label: string; value: string }> {
  const entries: Array<{ field: string; label: string; value: string }> = [];
  for (const field of FILLED_SUMMARY_FIELDS) {
    const value = displayFilledValue(draft, field);
    if (value) entries.push({ field, label: FIELD_LABELS[field], value });
  }
  return entries;
}

function ocrFieldCurrentValue(draft: PurchaseDetailsDraft, field: OcrFillableField): string {
  switch (field) {
    case 'invoiceNumber': return draft.invoiceNumber.trim();
    case 'purchaseDate': return draft.purchaseDate;
    case 'originalCurrency': return draft.originalCurrency;
    case 'originalExpense': return draft.originalExpense.trim();
    case 'receiptBuyerName': return draft.receiptBuyerName.trim();
    case 'convertedTwd': return draft.convertedTwd.trim();
    case 'billingCycle': return draft.billingCycle;
    case 'softwareName': return draft.softwareName.trim();
    case 'companyName': return draft.companyName.trim();
    case 'subscriptionStartDate': return draft.subscriptionStartDate;
    case 'subscriptionEndDate': return draft.subscriptionEndDate;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function assignOcrValue(draft: PurchaseDetailsDraft, suggestion: FieldSuggestion): PurchaseDetailsDraft {
  const next = { ...draft };
  switch (suggestion.field) {
    case 'billingCycle':
      next.billingCycle = suggestion.value === 'monthly' ? 'monthly' : 'annual';
      break;
    case 'softwareName': {
      next.softwareName = suggestion.value;
      const tool = findApprovedAiTool(suggestion.value);
      next.softwareToolId = tool?.id ?? '__other__';
      if (tool) next.companyName = tool.company;
      break;
    }
    case 'companyName':
      next.companyName = suggestion.value;
      break;
    case 'originalCurrency':
      if ((PURCHASE_CURRENCIES as readonly string[]).includes(suggestion.value)) {
        next.originalCurrency = suggestion.value as Exclude<PurchaseDetailsDraft['originalCurrency'], ''>;
      }
      break;
    case 'invoiceNumber':
    case 'purchaseDate':
    case 'originalExpense':
    case 'receiptBuyerName':
    case 'convertedTwd':
    case 'subscriptionStartDate':
    case 'subscriptionEndDate':
      next[suggestion.field] = suggestion.value;
      break;
    default: {
      const exhaustive: never = suggestion.field;
      return exhaustive;
    }
  }
  if (next.originalCurrency === 'TWD' && next.originalExpense && !next.convertedTwd.trim()) {
    const estimate = estimateConvertedTwd({
      originalCurrency: 'TWD',
      otherCurrency: null,
      originalExpense: next.originalExpense,
    });
    // Only seed an empty bank-payment field; never overwrite a card-screenshot value.
    if (estimate.estimatedTwd != null) next.convertedTwd = String(estimate.estimatedTwd);
  }
  return next;
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
    if (candidates.billingCycle) suggestions.push({ field: 'billingCycle', label: '繳費制度', value: candidates.billingCycle });
    if (candidates.softwareName) suggestions.push({ field: 'softwareName', label: '軟體名稱', value: candidates.softwareName });
    if (candidates.companyName) suggestions.push({ field: 'companyName', label: '軟體公司名稱', value: candidates.companyName });
    if (candidates.subscriptionStartDate) suggestions.push({ field: 'subscriptionStartDate', label: '訂閱開始日', value: candidates.subscriptionStartDate });
    if (candidates.subscriptionEndDate) suggestions.push({ field: 'subscriptionEndDate', label: '訂閱結束日', value: candidates.subscriptionEndDate });
    return suggestions;
  }
  if (requirementKey === 'card_transaction') {
    const candidates = extractCardTransactionCandidates(lines);
    return candidates.convertedTwd ? [{ field: 'convertedTwd', label: '銀行付款實付台幣', value: String(candidates.convertedTwd) }] : [];
  }
  return [];
}

function applyOcrHits(
  draft: PurchaseDetailsDraft,
  requirementKey: DocumentRequirementKey,
  lines: OcrLine[],
  overwrite: boolean,
): { draft: PurchaseDetailsDraft; applied: FieldSuggestion[] } {
  const suggestions = suggestionsFromOcr(requirementKey, lines);
  let next = draft;
  const applied: FieldSuggestion[] = [];
  for (const suggestion of suggestions) {
    const existing = ocrFieldCurrentValue(next, suggestion.field);
    if (!overwrite && existing) continue;
    next = assignOcrValue(next, suggestion);
    applied.push(suggestion);
  }
  return { draft: next, applied };
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels)];
}

function documentIsReady(document: DocumentRecord | null): boolean {
  return document?.status === 'ready';
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
  const [step, setStep] = useState<ReviewStep>('ocr');
  const [pendingFilePreview, setPendingFilePreview] = useState<Partial<Record<DocumentRequirementKey, { name: string; size: number }>>>({});
  const [ocrAppliedLabels, setOcrAppliedLabels] = useState<string[]>([]);
  const [ocrFilledSnapshot, setOcrFilledSnapshot] = useState<Array<{ field: string; label: string; value: string }>>([]);
  const [recognizingRequirements, setRecognizingRequirements] = useState<Set<DocumentRequirementKey>>(new Set());
  const ocrTokenByKeyRef = useRef<Partial<Record<DocumentRequirementKey, number>>>({});

  const parsedOcrDraft = useMemo(() => parseDraft(draft, { deferPaymentSource: true }), [draft]);
  const parsedFullDraft = useMemo(() => parseDraft(draft), [draft]);
  const detailsSaved = Boolean(
    parsedFullDraft.success
    && savedDetails
    && publicComparable(savedDetails) === publicComparable(parsedFullDraft.data)
    && !parsedFullDraft.data.cardLastFour
    && !parsedFullDraft.data.cardholderName
    && savedDetails.paymentSourceRegistered,
  );
  const ocrStageSaved = Boolean(
    parsedOcrDraft.success
    && savedDetails
    && publicComparable(savedDetails) === publicComparable(parsedOcrDraft.data),
  );
  const attachmentSpecs = useMemo(() => [
    REQUIREMENTS.identity_front,
    REQUIREMENTS.identity_back,
    ...(draft.specialStatus ? [REQUIREMENTS.special_status_proof] : []),
    REQUIREMENTS.passbook_cover,
    REQUIREMENTS.affidavit,
    ...(draft.payerType === 'representative' ? [REQUIREMENTS.representative_affidavit] : []),
  ], [draft.payerType, draft.specialStatus]);
  const requiredSpecs = useMemo(() => attachmentSpecs.filter((spec) => spec.required), [attachmentSpecs]);
  const latestDocument = useCallback((requirementKey: DocumentRequirementKey) => (
    documents.find((document) => document.requirementKey === requirementKey && document.status !== 'deleted') ?? null
  ), [documents]);
  const receiptReady = documentIsReady(latestDocument('vendor_receipt'));
  const cardReady = documentIsReady(latestDocument('card_transaction'));
  const ocrBusy = recognizingRequirements.size > 0
    || busyRequirements.has('vendor_receipt')
    || busyRequirements.has('card_transaction');
  const page1Gaps = page1MissingFields(draft);
  const page1Ready = receiptReady && cardReady && !ocrBusy && page1Gaps.length === 0;
  const showGapForm = (receiptReady || cardReady) && recognizingRequirements.size === 0;
  const page1Fields = page1EditableFields(draft);
  // OCR snapshot stays frozen after recognition; before any receipt OCR, show follow-up prefills only.
  const fillStatusEntries = ocrFilledSnapshot.length > 0
    ? ocrFilledSnapshot
    : (!receiptReady && !cardReady ? page1FilledEntries(draft) : []);
  const completedCount = requiredSpecs.filter((spec) => latestDocument(spec.key)?.status === 'ready').length;
  const readyToSubmit = detailsSaved && completedCount === requiredSpecs.length;
  const paymentUnlocked = ocrStageSaved;
  const attachmentsUnlocked = detailsSaved;

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
      ]).then(async ([detailsResult, documentResult, caseResult]) => {
        if (!active) return;
        setSavedDetails(detailsResult.details);
        let nextDraft = detailsResult.details ? draftFromDetails(detailsResult.details) : draftForApprovedTool(prefilledTool);
        const docs = documentResult.documents;
        const hasPayment = Boolean(detailsResult.details?.paymentSourceRegistered);
        const applied: FieldSuggestion[] = [];
        if (!hasPayment) {
          for (const spec of OCR_SPECS) {
            const document = docs.find((item) => item.requirementKey === spec.key && item.status === 'ready') ?? null;
            if (!document) continue;
            try {
              const recognized = await api.read<DocumentOcrResponseData>(`/api/v1/documents/${encodeURIComponent(document.id)}/ocr`);
              if (!active) return;
              const lines = recognized.ocr?.lines ? Array.from(recognized.ocr.lines) : [];
              const result = applyOcrHits(nextDraft, spec.key, lines, false);
              nextDraft = result.draft;
              applied.push(...result.applied);
            } catch {
              /* OCR is best-effort; the gap form covers misses. */
            }
          }
        }
        if (!active) return;
        setDraft(nextDraft);
        setOcrAppliedLabels(uniqueLabels(applied.map((item) => item.label)));
        setOcrFilledSnapshot(applied.map((item) => ({ field: item.field, label: item.label, value: item.value })));
        setDocuments(docs);
        setCaseEtag(caseResult.etag ?? null);
        const receipt = docs.some((item) => item.requirementKey === 'vendor_receipt' && item.status === 'ready');
        const card = docs.some((item) => item.requirementKey === 'card_transaction' && item.status === 'ready');
        const gaps = page1MissingFields(nextDraft);
        if (hasPayment && gaps.length === 0) setStep('attachments');
        else if (gaps.length === 0 && receipt && card) setStep('payment');
        else setStep('ocr');
        setMessage('');
      }).catch(() => {
        if (active) setMessage('附件暫時無法載入，請稍後再試。');
      }).finally(() => {
        if (active) setLoading(false);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, caseId, prefilledTool]);

  function updateDraft<K extends keyof PurchaseDetailsDraft>(key: K, value: PurchaseDetailsDraft[K]) {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === 'originalCurrency' || key === 'originalExpense' || key === 'otherCurrency') {
        if (next.originalCurrency === 'TWD' && next.originalExpense && !next.convertedTwd.trim()) {
          const estimate = estimateConvertedTwd({
            originalCurrency: next.originalCurrency,
            otherCurrency: next.otherCurrency || null,
            originalExpense: next.originalExpense,
          });
          // Seed only when the bank-payment field is still empty.
          if (estimate.estimatedTwd != null) next.convertedTwd = String(estimate.estimatedTwd);
        }
      }
      return next;
    });
    setConfirmed(false);
    setMessage('');
  }

  function confirmAmountMatch(nextDraft: PurchaseDetailsDraft = draft) {
    if (amountsDisagree(nextDraft)) window.alert('不符，請多確認');
  }

  async function saveDetails(options: { deferPaymentSource?: boolean; nextStep?: ReviewStep; draftOverride?: PurchaseDetailsDraft } = {}) {
    if (!caseId) return false;
    const currentDraft = options.draftOverride ?? draft;
    if (isBlockedAiToolLabel(currentDraft.softwareName) || isBlockedAiToolLabel(currentDraft.companyName)) {
      setMessage('本補助不適用中港澳開發之 AI 工具，請更換選項。');
      return false;
    }
    const parsed = parseDraft(currentDraft, { deferPaymentSource: options.deferPaymentSource });
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (!key || nextErrors[key]) continue;
        if (options.deferPaymentSource && (key === 'cardLastFour' || key === 'cardholderName')) continue;
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
      return false;
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
      setMessage(options.deferPaymentSource ? '購買資料已儲存，請繼續填寫付款資訊。' : '付款資訊已儲存。');
      if (options.nextStep) {
        setStep(options.nextStep);
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return true;
    } catch (error) {
      setMessage(error instanceof PublicApiError && error.code === 'ETAG_MISMATCH' ? '資料已更新，請重新儲存。' : '購買資料儲存失敗，請稍後再試。');
      return false;
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

  function nextOcrToken(key: DocumentRequirementKey): number {
    const next = (ocrTokenByKeyRef.current[key] ?? 0) + 1;
    ocrTokenByKeyRef.current[key] = next;
    return next;
  }

  function markRecognizing(key: DocumentRequirementKey, active: boolean) {
    setRecognizingRequirements((previous) => {
      const next = new Set(previous);
      if (active) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function uploadDocument(spec: RequirementSpec, file: File, etag: string): Promise<UploadWithOcr> {
    return api.upload<UploadWithOcr>(`/api/v1/cases/${encodeURIComponent(caseId!)}/documents`, {
      file, kind: spec.kind, requirementKey: spec.key, ifMatch: etag,
      onProgress: (percent) => setProgressByRequirement((previous) => ({ ...previous, [spec.key]: percent })),
    });
  }

  async function upload(spec: RequirementSpec, file: File | null) {
    if (!caseId || !file) return;
    if (file.size > MAX_BYTES) { setMessage('單一檔案大小上限為 12 MB。'); return; }
    if (isHeic(file)) { setMessage('不支援 HEIC 格式。請改用 JPG、PNG 或 PDF 上傳。'); return; }
    setPendingFilePreview((previous) => ({ ...previous, [spec.key]: { name: file.name, size: file.size } }));
    setConfirmed(false);
    const ocrToken = nextOcrToken(spec.key);
    markRecognizing(spec.key, false);
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
      setMessage(`${spec.label}已上傳（${file.name} · ${formatBytes(file.size)}）。`);
      markBusy(spec.key, false);
      setProgressByRequirement((previous) => { const next = { ...previous }; delete next[spec.key]; return next; });
      if (OCR_ELIGIBLE_REQUIREMENTS.has(spec.key) && uploaded.document.id) {
        markRecognizing(spec.key, true);
        try {
          const recognized = await api.read<DocumentOcrResponseData>(`/api/v1/documents/${encodeURIComponent(uploaded.document.id)}/ocr`);
          if (ocrTokenByKeyRef.current[spec.key] !== ocrToken) return;
          const lines = recognized.ocr?.lines ? Array.from(recognized.ocr.lines) : [];
          const hits = suggestionsFromOcr(spec.key, lines);
          setDraft((current) => applyOcrHits(current, spec.key, lines, true).draft);
          if (hits.length > 0) {
            setOcrAppliedLabels((previous) => uniqueLabels([...previous, ...hits.map((item) => item.label)]));
            setOcrFilledSnapshot((previous) => {
              const next = [...previous];
              for (const hit of hits) {
                const index = next.findIndex((entry) => entry.field === hit.field);
                const entry = { field: hit.field, label: hit.label, value: hit.value };
                if (index >= 0) next[index] = entry;
                else next.push(entry);
              }
              return next;
            });
          }
        } catch {
          if (ocrTokenByKeyRef.current[spec.key] !== ocrToken) return;
        } finally {
          if (ocrTokenByKeyRef.current[spec.key] === ocrToken) markRecognizing(spec.key, false);
        }
      }
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
    nextOcrToken(key);
    markRecognizing(key, false);
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

  function goToStep(next: ReviewStep) {
    switch (next) {
      case 'ocr':
        setStep(next);
        return;
      case 'payment':
        if (!paymentUnlocked) return;
        setStep(next);
        return;
      case 'attachments':
        if (!attachmentsUnlocked) return;
        setStep(next);
        return;
      default: {
        const exhaustive: never = next;
        return exhaustive;
      }
    }
  }

  function renderRequirement(spec: RequirementSpec) {
    const document = latestDocument(spec.key);
    const isBusy = busyRequirements.has(spec.key);
    const isReady = document?.status === 'ready';
    const preview = pendingFilePreview[spec.key];
    const progress = progressByRequirement[spec.key];
    const isRecognizing = recognizingRequirements.has(spec.key);
    return (
      <article className={isReady ? 'attachment-requirement is-complete' : 'attachment-requirement'} key={spec.key}>
        <div className="attachment-requirement-copy">
          <span className="attachment-check" aria-hidden="true">{isReady ? '✓' : spec.required ? '＊' : '－'}</span>
          <div>
            <h4>{spec.label}<em>{spec.required ? '必備' : '選填'}</em></h4>
            <p>{spec.hint}</p>
            {document && <small>{isReady ? `已上傳 · ${formatBytes(document.byteSize)}` : '檔案處理中'}</small>}
            {preview && isBusy && <small>已選取：{preview.name} · {formatBytes(preview.size)}</small>}
            {typeof progress === 'number' && isBusy && <progress max={100} value={progress} aria-label={`${spec.label}上傳進度`}>{progress}%</progress>}
            {isRecognizing && <small>正在辨識…</small>}
          </div>
        </div>
        <div className="attachment-requirement-actions">
          <label className="file-picker-button">
            {isBusy ? `上傳中 ${progress ?? 0}%` : document ? '重新上傳' : '選擇檔案'}
            <input type="file" accept={ACCEPTED_FILES} disabled={isBusy || submitting} onChange={(event) => { const selected = event.target.files?.[0] ?? null; event.currentTarget.value = ''; void upload(spec, selected); }} />
          </label>
          {document && <button type="button" className="text-action" disabled={isBusy || submitting} onClick={() => void remove(document, spec.label)}>移除</button>}
        </div>
      </article>
    );
  }

  function renderGapField(field: Page1GapField) {
    switch (field) {
      case 'applicantName':
        return <label key={field}>申請人姓名 <span aria-hidden="true">＊</span><input data-field="applicantName" value={draft.applicantName} maxLength={100} autoComplete="name" aria-invalid={Boolean(fieldErrors.applicantName)} placeholder="例如：陳大文" onChange={(event) => updateDraft('applicantName', event.target.value)} /><small>請填寫與身分證件一致的姓名。</small>{fieldErrors.applicantName && <p className="field-error" role="alert">{fieldErrors.applicantName}</p>}</label>;
      case 'billingCycle':
        return (
          <fieldset key={field}>
            <legend>繳費制度 <span aria-hidden="true">＊</span></legend>
            <div className="choice-row">
              <label><input type="radio" name="billing-cycle" checked={draft.billingCycle === 'annual'} onChange={() => updateDraft('billingCycle', 'annual')} />年費制</label>
              <label><input type="radio" name="billing-cycle" checked={draft.billingCycle === 'monthly'} onChange={() => updateDraft('billingCycle', 'monthly')} />月費制</label>
            </div>
          </fieldset>
        );
      case 'billingPeriods':
        return <label key={field} className="inline-number-field">共 <input aria-label="月費期數" data-field="billingPeriods" type="number" min="1" max="120" inputMode="numeric" value={draft.billingPeriods} aria-invalid={Boolean(fieldErrors.billingPeriods)} onChange={(event) => updateDraft('billingPeriods', event.target.value)} /> 期{fieldErrors.billingPeriods && <p className="field-error" role="alert">{fieldErrors.billingPeriods}</p>}</label>;
      case 'softwareFunction':
        return (
          <fieldset key={field}>
            <legend>軟體功能 <span aria-hidden="true">＊</span></legend>
            <div className="choice-grid">{([['general', '通用型'], ['imaging', '影像類'], ['office', '辦公類'], ['learning', '學習類'], ['other', '其他']] as const).map(([value, label]) => <label key={value}><input type="radio" name="software-function" checked={draft.softwareFunction === value} onChange={() => updateDraft('softwareFunction', value)} />{label}</label>)}</div>
          </fieldset>
        );
      case 'otherFunction':
        return <label key={field}>其他功能名稱<input data-field="otherFunction" value={draft.otherFunction} maxLength={100} aria-invalid={Boolean(fieldErrors.otherFunction)} onChange={(event) => updateDraft('otherFunction', event.target.value)} />{fieldErrors.otherFunction && <p className="field-error" role="alert">{fieldErrors.otherFunction}</p>}</label>;
      case 'softwareName':
        return (
          <div key={field} data-field="softwareName">
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
        );
      case 'companyName':
        return <label key={field}>軟體公司名稱 <span aria-hidden="true">＊</span><input data-field="companyName" value={draft.companyName} maxLength={200} autoComplete="organization" aria-invalid={Boolean(fieldErrors.companyName)} onChange={(event) => updateDraft('companyName', event.target.value)} />{fieldErrors.companyName && <p className="field-error" role="alert">{fieldErrors.companyName}</p>}</label>;
      case 'purchaseDate':
        return <label key={field}>購買日期 <span aria-hidden="true">＊</span><input data-field="purchaseDate" type="date" value={draft.purchaseDate} aria-invalid={Boolean(fieldErrors.purchaseDate)} onChange={(event) => updateDraft('purchaseDate', event.target.value)} />{fieldErrors.purchaseDate && <p className="field-error" role="alert">{fieldErrors.purchaseDate}</p>}</label>;
      case 'receiptBuyerName':
        return <label key={field}>官方收據上的買受人姓名 <span aria-hidden="true">＊</span><input data-field="receiptBuyerName" value={draft.receiptBuyerName} maxLength={100} aria-invalid={Boolean(fieldErrors.receiptBuyerName)} placeholder="請照抄收據上顯示的姓名" onChange={(event) => updateDraft('receiptBuyerName', event.target.value)} /><small>請填寫「官方收據」文件上列出的買受人姓名，用於核對是否與申請人或代付人一致。</small>{fieldErrors.receiptBuyerName && <p className="field-error" role="alert">{fieldErrors.receiptBuyerName}</p>}</label>;
      case 'originalCurrency':
        return (
          <fieldset key={field}>
            <legend>原始費用幣別 <span aria-hidden="true">＊</span></legend>
            <div className="choice-grid currency-choices">{([['TWD', '新臺幣'], ['USD', '美金'], ['JPY', '日圓'], ['EUR', '歐元'], ['AUD', '澳幣'], ['HKD', '港幣'], ['OTHER', '其他']] as const).map(([value, label]) => <label key={value}><input type="radio" name="currency" checked={draft.originalCurrency === value} onChange={() => updateDraft('originalCurrency', value)} />{label}</label>)}</div>
          </fieldset>
        );
      case 'otherCurrency':
        return <label key={field}>其他幣別<input data-field="otherCurrency" value={draft.otherCurrency} maxLength={24} onChange={(event) => updateDraft('otherCurrency', event.target.value)} /></label>;
      case 'originalExpense':
        return <label key={field}>原始費用 <span aria-hidden="true">＊</span><input data-field="originalExpense" type="text" inputMode="decimal" placeholder="例如 29.99" value={draft.originalExpense} aria-invalid={Boolean(fieldErrors.originalExpense)} onChange={(event) => updateDraft('originalExpense', event.target.value)} onBlur={() => confirmAmountMatch()} />{fieldErrors.originalExpense && <p className="field-error" role="alert">{fieldErrors.originalExpense}</p>}</label>;
      case 'convertedTwd':
        return (
          <label key={field}>銀行付款實付台幣 <span aria-hidden="true">＊</span>
            <input
              data-field="convertedTwd"
              type="number"
              min="1"
              max="100000000"
              inputMode="numeric"
              placeholder="例如 630"
              value={draft.convertedTwd}
              aria-invalid={Boolean(fieldErrors.convertedTwd)}
              onChange={(event) => updateDraft('convertedTwd', event.target.value)}
              onBlur={() => confirmAmountMatch()}
            />
            <small>請依「刷卡單筆明細」銀行 App 截圖上的實付台幣填寫。</small>
            {fieldErrors.convertedTwd && <p className="field-error" role="alert">{fieldErrors.convertedTwd}</p>}
          </label>
        );
      case 'subscriptionStartDate':
        return <fieldset key={field}><legend>訂閱開始日 <span aria-hidden="true">＊</span></legend><input data-field="subscriptionStartDate" type="date" value={draft.subscriptionStartDate} aria-invalid={Boolean(fieldErrors.subscriptionStartDate)} onChange={(event) => updateDraft('subscriptionStartDate', event.target.value)} /><small>請依發票或訂閱憑證標示之啟用日填寫。</small>{fieldErrors.subscriptionStartDate && <p className="field-error" role="alert">{fieldErrors.subscriptionStartDate}</p>}</fieldset>;
      case 'subscriptionEndDate':
        return <fieldset key={field}><legend>訂閱結束日 <span aria-hidden="true">＊</span></legend><input data-field="subscriptionEndDate" type="date" value={draft.subscriptionEndDate} aria-invalid={Boolean(fieldErrors.subscriptionEndDate)} onChange={(event) => updateDraft('subscriptionEndDate', event.target.value)} /><small>請依發票或訂閱憑證標示之到期日填寫。</small>{fieldErrors.subscriptionEndDate && <p className="field-error" role="alert">{fieldErrors.subscriptionEndDate}</p>}</fieldset>;
      default: {
        const exhaustive: never = field;
        return exhaustive;
      }
    }
  }

  if (!caseId) return null;
  if (loading) return <p className="pending-note" role="status">附件載入中…</p>;

  return (
    <section className="document-review attachment-step" aria-labelledby="documents-title">
      <header className="attachment-step-header">
        <p className="eyebrow">第 2 部分</p>
        <h2 id="documents-title">購買資料與附件</h2>
        <p>請先上傳官方收據與刷卡單筆明細，系統會辨識購買資料；缺漏欄位請自行補填，再填寫付款資訊並上傳其餘附件。</p>
        <div className="attachment-step-tabs" role="tablist" aria-label="附件流程">
          <button type="button" role="tab" aria-selected={step === 'ocr'} className={step === 'ocr' ? 'is-current' : undefined} onClick={() => goToStep('ocr')}>1. 辨識購買資料</button>
          <button type="button" role="tab" aria-selected={step === 'payment'} className={step === 'payment' ? 'is-current' : undefined} onClick={() => goToStep('payment')} disabled={!paymentUnlocked && step !== 'payment'}>2. 付款資訊</button>
          <button type="button" role="tab" aria-selected={step === 'attachments'} className={step === 'attachments' ? 'is-current' : undefined} onClick={() => goToStep('attachments')} disabled={!attachmentsUnlocked && step !== 'attachments'}>3. 其他附件</button>
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

      {step === 'ocr' && (
        <section className="attachment-section-card" aria-labelledby="ocr-details-title">
          <div className="attachment-section-heading"><div><span>1</span><h3 id="ocr-details-title">辨識購買資料</h3></div><strong className={page1Ready ? 'attachment-status is-complete' : 'attachment-status'}>{page1Ready ? '已完成' : '尚未完成'}</strong></div>
          <p className="field-hint">支援 JPEG、PNG 或未加密之 PDF。單一檔案上限 12 MB。不支援 HEIC 格式（如使用 iPhone 請設定為相容格式 JPG）。</p>
          <div className="attachment-requirement-list">
            {OCR_SPECS.map((spec) => renderRequirement(spec))}
          </div>
          {fillStatusEntries.length > 0 && (
            <aside className="ocr-fill-status" aria-label="已帶入的購買資料">
              <p>{ocrAppliedLabels.length > 0 ? `已從收據／明細帶入：${ocrAppliedLabels.join('、')}` : '已帶入購買資料：'}</p>
              <ul>
                {fillStatusEntries.map((entry) => (
                  <li key={entry.field}>{entry.label}：{entry.value}</li>
                ))}
              </ul>
            </aside>
          )}
          {showGapForm && (
            <form className="purchase-details-form" onSubmit={(event) => { event.preventDefault(); }} noValidate>
              {page1Gaps.length > 0 ? (
                <p className="field-hint">請補填辨識不到的資料：{page1Gaps.map((field) => FIELD_LABELS[field]).join('、')}。已帶入的欄位仍可直接修改。</p>
              ) : (
                <p className="field-hint">請確認下列購買資料；若有誤可直接修改。</p>
              )}
              {page1Fields.map((field) => renderGapField(field))}
              <label>出生日期<input data-field="birthDate" type="date" value={draft.birthDate} aria-invalid={Boolean(fieldErrors.birthDate)} onChange={(event) => updateDraft('birthDate', event.target.value)} /><small>用於確認本方案的年齡資格。</small>{fieldErrors.birthDate && <p className="field-error" role="alert">{fieldErrors.birthDate}</p>}</label>
              <label>身分證字號 <span aria-hidden="true">＊</span><input data-field="nationalId" value={draft.nationalId} maxLength={10} autoComplete="off" spellCheck={false} aria-invalid={Boolean(fieldErrors.nationalId)} placeholder="例如：A123456789" onChange={(event) => updateDraft('nationalId', event.target.value.toUpperCase().replace(/[^A-Z0-9]/gi, '').slice(0, 10))} /><small>請填寫與身分證件一致的字號。</small>{fieldErrors.nationalId && <p className="field-error" role="alert">{fieldErrors.nationalId}</p>}</label>
              <label>戶籍地址 <span aria-hidden="true">＊</span><input data-field="householdAddress" value={draft.householdAddress} maxLength={200} autoComplete="street-address" aria-invalid={Boolean(fieldErrors.householdAddress)} placeholder="請依身分證登記之戶籍地址填寫" onChange={(event) => updateDraft('householdAddress', event.target.value)} /><small>請填寫身分證上的戶籍地址。</small>{fieldErrors.householdAddress && <p className="field-error" role="alert">{fieldErrors.householdAddress}</p>}</label>
            </form>
          )}
          <div className="wizard-actions">
            <button
              type="button"
              className="primary-action"
              disabled={!page1Ready || saving}
              onClick={() => void saveDetails({ deferPaymentSource: true, nextStep: 'payment' })}
            >
              {saving ? '儲存中…' : '儲存並前往付款資訊'}
            </button>
          </div>
        </section>
      )}

      {step === 'payment' && (
        <section className="attachment-section-card" aria-labelledby="payment-details-title">
          <div className="attachment-section-heading"><div><span>2</span><h3 id="payment-details-title">付款資訊</h3></div><strong className={detailsSaved ? 'attachment-status is-complete' : 'attachment-status'}>{detailsSaved ? '已儲存' : '尚未完成'}</strong></div>
          <form className="purchase-details-form" onSubmit={(event) => { event.preventDefault(); void saveDetails({ nextStep: 'attachments' }); }} noValidate>
            <fieldset><legend>付款人 <span aria-hidden="true">＊</span></legend><div className="choice-stack"><label><input type="radio" name="payer" checked={draft.payerType === 'self_card'} onChange={() => updateDraft('payerType', 'self_card')} />本人信用卡</label><label><input type="radio" name="payer" checked={draft.payerType === 'representative'} onChange={() => updateDraft('payerType', 'representative')} />父母、配偶或法定代理人代付</label></div></fieldset>
            <aside className="sensitive-data-note" aria-labelledby="card-privacy-title">
              <h4 id="card-privacy-title">信用卡資訊用途與安全說明</h4>
              <p>為核對購買真實性並防範重複請領，系統僅加密比對卡號末四碼與持卡人姓名，絕不留存完整卡號明文或安全碼。</p>
            </aside>
            <div className="purchase-field-grid"><label>信用卡末四碼 <span aria-hidden="true">＊</span><input data-field="cardLastFour" value={draft.cardLastFour} inputMode="numeric" maxLength={4} autoComplete="off" aria-invalid={Boolean(fieldErrors.cardLastFour)} placeholder={draft.paymentSourceRegistered ? '已登記（可留空）' : '例如 1234'} onChange={(event) => updateDraft('cardLastFour', event.target.value.replace(/\D/g, '').slice(0, 4))} /><small>{draft.paymentSourceRegistered ? '已登記付款卡號資訊，若未變更可留空。' : '僅用於防重複請領檢核。系統不保留明文。'}</small>{fieldErrors.cardLastFour && <p className="field-error" role="alert">{fieldErrors.cardLastFour}</p>}</label><label>持卡人姓名 <span aria-hidden="true">＊</span><input data-field="cardholderName" value={draft.cardholderName} maxLength={100} autoComplete="cc-name" aria-invalid={Boolean(fieldErrors.cardholderName)} placeholder={draft.paymentSourceRegistered ? '已登記（可留空）' : '須與卡片一致'} onChange={(event) => updateDraft('cardholderName', event.target.value)} />{fieldErrors.cardholderName && <p className="field-error" role="alert">{fieldErrors.cardholderName}</p>}</label></div>
            <div className="wizard-actions">
              <button type="button" className="secondary-action" onClick={() => goToStep('ocr')}>返回辨識購買資料</button>
              {detailsSaved ? (
                <button type="button" className="primary-action" onClick={() => goToStep('attachments')}>前往其他附件</button>
              ) : (
                <button type="submit" className="primary-action" disabled={saving}>{saving ? '儲存中…' : '儲存並前往附件'}</button>
              )}
            </div>
          </form>
        </section>
      )}

      {step === 'attachments' && (
        <>
          <section className="attachment-section-card" aria-labelledby="required-files-title">
            <div className="attachment-section-heading"><div><span>3</span><h3 id="required-files-title">上傳其餘附件</h3></div><strong className="attachment-progress">{completedCount} / {requiredSpecs.length}</strong></div>
            <aside className="sensitive-data-note" aria-labelledby="docs-privacy-title">
              <h4 id="docs-privacy-title">個人證件與存摺隱私保護</h4>
              <p>您上傳的個人證件與存摺封面均以專屬金鑰加密存放，僅供本計畫審核使用，並依規定安全銷毀。</p>
            </aside>
            <fieldset><legend>資格證明</legend><label className="checkbox-card"><input type="checkbox" checked={draft.specialStatus} onChange={(event) => {
              const checked = event.target.checked;
              const nextDraft = { ...draft, specialStatus: checked };
              setDraft(nextDraft);
              setConfirmed(false);
              void saveDetails({ deferPaymentSource: !draft.paymentSourceRegistered, draftOverride: nextDraft });
            }} /><span><strong>具低收／中低收入戶資格</strong><small>符合者補助合格購買金額之 90%（上限 6,000 元）；請勾選並上傳有效證明。</small></span></label></fieldset>
            <p className="field-hint">支援 JPEG、PNG 或未加密之 PDF。單一檔案上限 12 MB。不支援 HEIC 格式（如使用 iPhone 請設定為相容格式 JPG）。</p>
            <div className="attachment-requirement-list">
              {attachmentSpecs.map((spec) => renderRequirement(spec))}
            </div>
            <button type="button" className="secondary-action" onClick={() => goToStep('payment')}>返回付款資訊</button>
          </section>

          <section className="attachment-submit-card" aria-labelledby="formal-submit-title">
            <h3 id="formal-submit-title">送出申請</h3>
            {!detailsSaved && (
              <p role="status">請先完成購買資料與付款資訊。</p>
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
