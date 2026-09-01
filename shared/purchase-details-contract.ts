import { z } from 'zod';

export const PURCHASE_FUNCTIONS = ['general', 'imaging', 'office', 'learning', 'other'] as const;
export const PURCHASE_CURRENCIES = ['TWD', 'USD', 'JPY', 'EUR', 'AUD', 'HKD', 'OTHER'] as const;

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}, '購買日期不正確');

const decimalAmount = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/);

export const PurchaseDetailsSchema = z.object({
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
}).strict().superRefine((details, context) => {
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
});

export type PurchaseDetails = z.infer<typeof PurchaseDetailsSchema>;

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
