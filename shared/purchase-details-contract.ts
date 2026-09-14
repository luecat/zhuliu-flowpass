import { z } from 'zod';

export const PURCHASE_FUNCTIONS = ['general', 'imaging', 'office', 'learning', 'other'] as const;
export const PURCHASE_CURRENCIES = ['TWD', 'USD', 'JPY', 'EUR', 'AUD', 'HKD', 'OTHER'] as const;

const createCalendarDate = (label = '日期') => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}, `${label}格式不正確`);

const calendarDate = createCalendarDate('購買日期');
const subscriptionStartDateSchema = createCalendarDate('訂閱開始日');
const subscriptionEndDateSchema = createCalendarDate('訂閱結束日');

const decimalAmount = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/);

const purchaseDetailsBase = {
  billingCycle: z.enum(['annual', 'monthly']),
  billingPeriods: z.number().int().min(1).max(120).nullable(),
  softwareFunction: z.enum(PURCHASE_FUNCTIONS),
  otherFunction: z.string().trim().max(100).nullable(),
  softwareName: z.string().trim().min(1).max(200),
  companyName: z.string().trim().min(1).max(200),
  purchaseDate: calendarDate,
  payerType: z.enum(['self_card', 'representative']),
  originalCurrency: z.enum(PURCHASE_CURRENCIES),
  otherCurrency: z.string().trim().max(24).nullable(),
  originalExpense: decimalAmount,
  convertedTwd: z.number().int().min(1).max(100_000_000),
  specialStatus: z.boolean(),
  invoiceNumber: z.string().trim().min(1).max(40).nullable(),
  // Legacy rows may omit these; normalize missing to null on read.
  subscriptionStartDate: subscriptionStartDateSchema.nullish().transform((value) => value ?? null),
  subscriptionEndDate: subscriptionEndDateSchema.nullish().transform((value) => value ?? null),
  // Collected in stage-2 purchase form; legacy rows may omit.
  applicantName: z.string().trim().max(100).nullish().transform((value) => value?.trim() ? value.trim() : null),
} as const;

function refinePurchaseShape<T extends {
  billingCycle: 'annual' | 'monthly';
  billingPeriods: number | null;
  softwareFunction: (typeof PURCHASE_FUNCTIONS)[number];
  otherFunction: string | null;
  originalCurrency: (typeof PURCHASE_CURRENCIES)[number];
  otherCurrency: string | null;
  subscriptionStartDate: string | null;
  subscriptionEndDate: string | null;
  applicantName: string | null;
}>(details: T, context: z.RefinementCtx, options: { requireSubscriptionDates: boolean; requireApplicantName: boolean }) {
  if (details.billingCycle === 'monthly' && details.billingPeriods === null) {
    context.addIssue({ code: 'custom', path: ['billingPeriods'], message: '請填寫月費期數' });
  }
  if (details.billingCycle === 'annual' && details.billingPeriods !== null) {
    context.addIssue({ code: 'custom', path: ['billingPeriods'], message: '年費不需要期數' });
  }
  if (details.softwareFunction === 'other' && !details.otherFunction) {
    context.addIssue({ code: 'custom', path: ['otherFunction'], message: '請填寫其他功能' });
  }
  if (details.softwareFunction !== 'other' && details.otherFunction !== null) {
    context.addIssue({ code: 'custom', path: ['otherFunction'], message: '非其他類別不需要說明' });
  }
  if (details.originalCurrency === 'OTHER' && !details.otherCurrency) {
    context.addIssue({ code: 'custom', path: ['otherCurrency'], message: '請填寫幣別' });
  }
  if (details.originalCurrency !== 'OTHER' && details.otherCurrency !== null) {
    context.addIssue({ code: 'custom', path: ['otherCurrency'], message: '已選擇幣別時不需要其他說明' });
  }
  if (options.requireSubscriptionDates) {
    if (!details.subscriptionStartDate) {
      context.addIssue({ code: 'custom', path: ['subscriptionStartDate'], message: '請填寫訂閱開始日' });
    }
    if (!details.subscriptionEndDate) {
      context.addIssue({ code: 'custom', path: ['subscriptionEndDate'], message: '請填寫訂閱結束日' });
    }
  }
  if (details.subscriptionStartDate && details.subscriptionEndDate) {
    const start = new Date(details.subscriptionStartDate);
    const end = new Date(details.subscriptionEndDate);
    if (end < start) {
      context.addIssue({
        code: 'custom',
        path: ['subscriptionEndDate'],
        message: '訂閱結束日必須晚於或等於開始日'
      });
    }
  }
  if (options.requireApplicantName && !details.applicantName) {
    context.addIssue({ code: 'custom', path: ['applicantName'], message: '請填寫申請人姓名' });
  }
}

/** Persisted purchase details: never stores card last-four or cardholder name in plaintext. */
export const PurchaseDetailsSchema = z.object({
  ...purchaseDetailsBase,
  paymentSourceFingerprint: z.string().min(16).max(128).nullable(),
}).strict().superRefine((details, context) => {
  refinePurchaseShape(details, context, { requireSubscriptionDates: false, requireApplicantName: false });
});

export type PurchaseDetails = z.infer<typeof PurchaseDetailsSchema>;

/**
 * Applicant write payload. Card last-four + cardholder name are accepted only to
 * derive an HMAC fingerprint, then discarded before persistence.
 */
export const PurchaseDetailsWriteSchema = z.object({
  ...purchaseDetailsBase,
  cardLastFour: z.string().regex(/^\d{4}$/).nullable(),
  cardholderName: z.string().trim().min(1).max(100).nullable(),
  /** When true, keep the previously stored payment fingerprint without re-entering card digits. */
  keepExistingPaymentSource: z.boolean().optional(),
}).strict().superRefine((details, context) => {
  refinePurchaseShape(details, context, { requireSubscriptionDates: true, requireApplicantName: true });
  const hasCard = Boolean(details.cardLastFour);
  const hasName = Boolean(details.cardholderName);
  if (details.keepExistingPaymentSource) {
    if (hasCard !== hasName) {
      context.addIssue({
        code: 'custom',
        path: hasCard ? ['cardholderName'] : ['cardLastFour'],
        message: '信用卡末四碼與持卡人姓名需一併填寫',
      });
    }
    return;
  }
  if (!hasCard) {
    context.addIssue({ code: 'custom', path: ['cardLastFour'], message: '請填寫信用卡末四碼' });
  }
  if (!hasName) {
    context.addIssue({ code: 'custom', path: ['cardholderName'], message: '請填寫持卡人姓名' });
  }
});

export type PurchaseDetailsWrite = z.infer<typeof PurchaseDetailsWriteSchema>;

export const DOCUMENT_REQUIREMENT_KEYS = [
  'identity_front',
  'identity_back',
  'special_status_proof',
  'purchase_proof',
  'passbook_cover',
  'affidavit',
  'representative_affidavit',
  'supplement_other',
] as const;

export const DocumentRequirementKeySchema = z.enum(DOCUMENT_REQUIREMENT_KEYS);
export type DocumentRequirementKey = z.infer<typeof DocumentRequirementKeySchema>;

export function toPublicPurchaseDetails(details: PurchaseDetails): Omit<PurchaseDetails, 'paymentSourceFingerprint'> & {
  paymentSourceRegistered: boolean;
} {
  const { paymentSourceFingerprint, ...rest } = details;
  return {
    ...rest,
    paymentSourceRegistered: Boolean(paymentSourceFingerprint),
  };
}
