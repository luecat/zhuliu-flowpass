import { z } from 'zod';

export const PURCHASE_FUNCTIONS = ['general', 'imaging', 'office', 'learning', 'other'] as const;
export const PURCHASE_CURRENCIES = ['TWD', 'USD', 'JPY', 'EUR', 'AUD', 'HKD', 'OTHER'] as const;

// Applicant forms show these messages verbatim, so every issue carries plain Chinese copy.
const createCalendarDate = (label = '日期') => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `請選擇${label}`).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}, `${label}格式不正確`);

const calendarDate = createCalendarDate('購買日期');
const subscriptionStartDateSchema = createCalendarDate('訂閱開始日');
const subscriptionEndDateSchema = createCalendarDate('訂閱結束日');

const decimalAmount = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/, '請填寫金額（數字，最多兩位小數）');

/** Taiwan National ID letter codes used by the official checksum. */
const NATIONAL_ID_LETTER_CODES: Record<string, number> = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
};

export function isValidTaiwanNationalId(value: string): boolean {
  const id = value.trim().toUpperCase();
  if (!/^[A-Z][12]\d{8}$/.test(id)) return false;
  const code = NATIONAL_ID_LETTER_CODES[id[0]!];
  if (code === undefined) return false;
  const digits = [Math.floor(code / 10), code % 10, ...id.slice(1).split('').map(Number)];
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = digits.reduce((total, digit, index) => total + digit * weights[index]!, 0);
  return sum % 10 === 0;
}

const nationalIdSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z][12]\d{8}$/, '身分證字號格式不正確')
      .refine(isValidTaiwanNationalId, '身分證字號檢核碼不正確'),
  );

const purchaseDetailsBase = {
  billingCycle: z.enum(['annual', 'monthly']),
  billingPeriods: z.number({ error: '請填寫月費期數' }).int('月費期數請填寫整數').min(1, '月費期數需介於 1 到 120 期').max(120, '月費期數需介於 1 到 120 期').nullable(),
  softwareFunction: z.enum(PURCHASE_FUNCTIONS),
  otherFunction: z.string().trim().max(100).nullable(),
  softwareName: z.string().trim().min(1, '請選擇軟體名稱').max(200),
  companyName: z.string().trim().min(1, '請填寫軟體公司名稱').max(200),
  purchaseDate: calendarDate,
  payerType: z.enum(['self_card', 'representative']),
  originalCurrency: z.enum(PURCHASE_CURRENCIES),
  otherCurrency: z.string().trim().max(24).nullable(),
  originalExpense: decimalAmount,
  convertedTwd: z.number({ error: '請填寫銀行付款實付台幣' }).int('實付台幣請填寫整數').min(1, '請填寫銀行付款實付台幣').max(100_000_000, '實付台幣超過上限'),
  specialStatus: z.boolean(),
  invoiceNumber: z.string().trim().min(1).max(40).nullable(),
  // Legacy rows may omit these; normalize missing to null on read.
  subscriptionStartDate: subscriptionStartDateSchema.nullish().transform((value) => value ?? null),
  subscriptionEndDate: subscriptionEndDateSchema.nullish().transform((value) => value ?? null),
  // Collected in stage-2 purchase form; legacy rows may omit.
  applicantName: z.string().trim().max(100).nullish().transform((value) => value?.trim() ? value.trim() : null),
  /**
   * Buyer name as printed on the official vendor receipt. Self-filled by the
   * applicant until OCR is wired into the upload flow; a missing value means
   * "not read yet", not "absent", so the name-consistency rule treats it as
   * needs-review rather than a mismatch.
   */
  receiptBuyerName: z.string().trim().max(100).nullish().transform((value) => value?.trim() ? value.trim() : null),
  /** Applicant date of birth, for the age-eligibility rule. Optional: older rows predate this field. */
  birthDate: createCalendarDate('出生日期').nullish().transform((value) => value ?? null),
  /** Taiwan National ID (身分證字號). Legacy rows may omit. */
  nationalId: nationalIdSchema.nullish().transform((value) => value ?? null),
  /** Household registration address (戶籍地址). Legacy rows may omit. */
  householdAddress: z.string().trim().max(200).nullish().transform((value) => value?.trim() ? value.trim() : null),
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
  nationalId: string | null;
  householdAddress: string | null;
}>(details: T, context: z.RefinementCtx, options: {
  requireSubscriptionDates: boolean;
  requireApplicantName: boolean;
  requireIdentityFields: boolean;
}) {
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
  if (options.requireIdentityFields) {
    if (!details.nationalId) {
      context.addIssue({ code: 'custom', path: ['nationalId'], message: '請填寫身分證字號' });
    }
    if (!details.householdAddress) {
      context.addIssue({ code: 'custom', path: ['householdAddress'], message: '請填寫戶籍地址' });
    }
  }
}

/** Persisted purchase details: never stores card last-four or cardholder name in plaintext. */
export const PurchaseDetailsSchema = z.object({
  ...purchaseDetailsBase,
  paymentSourceFingerprint: z.string().min(16).max(128).nullable(),
}).strict().superRefine((details, context) => {
  refinePurchaseShape(details, context, {
    requireSubscriptionDates: false,
    requireApplicantName: false,
    requireIdentityFields: false,
  });
});

export type PurchaseDetails = z.infer<typeof PurchaseDetailsSchema>;

/**
 * Applicant write payload. Card last-four + cardholder name are accepted only to
 * derive an HMAC fingerprint, then discarded before persistence.
 */
export const PurchaseDetailsWriteSchema = z.object({
  ...purchaseDetailsBase,
  cardLastFour: z.string().regex(/^\d{4}$/, '信用卡末四碼請填寫 4 位數字').nullable(),
  cardholderName: z.string().trim().min(1).max(100).nullable(),
  /** When true, keep the previously stored payment fingerprint without re-entering card digits. */
  keepExistingPaymentSource: z.boolean().optional(),
  /**
   * OCR-page save: persist purchase fields before the applicant types card
   * last-four / cardholder name. Submission still requires a later full save.
   */
  deferPaymentSource: z.boolean().optional(),
}).strict().superRefine((details, context) => {
  refinePurchaseShape(details, context, {
    requireSubscriptionDates: true,
    requireApplicantName: true,
    requireIdentityFields: true,
  });
  const hasCard = Boolean(details.cardLastFour);
  const hasName = Boolean(details.cardholderName);
  if (details.deferPaymentSource) {
    if (hasCard !== hasName) {
      context.addIssue({
        code: 'custom',
        path: hasCard ? ['cardholderName'] : ['cardLastFour'],
        message: '信用卡末四碼與持卡人姓名需一併填寫',
      });
    }
    return;
  }
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
  // Legacy value from before purchase proof split into two documents (see
  // vendor_receipt/card_transaction below). Kept so old rows still validate;
  // never required for new submissions and never backfilled.
  'purchase_proof',
  'vendor_receipt',
  'card_transaction',
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
