import { APPROVED_AI_TOOLS, type ApprovedAiTool } from '../../shared/approved-ai-tools';
import type { OcrLineContract } from '../../shared/ocr-contract';

export type OcrLine = OcrLineContract;

/**
 * Turns raw OCR lines into candidate form values. This is the only place that
 * interprets what a recognized line means — the OCR engine itself never does
 * (see server/adapters/ocr/ocr-engine.ts). Every extractor returns null when
 * it isn't confident rather than guessing: a blank field the applicant fills
 * in is safe, a wrong value silently accepted is not.
 */

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function texts(lines: readonly OcrLine[]): string[] {
  return lines.map((line) => line.text.trim()).filter(Boolean);
}

/** "June 11, 2026" / "2026-06-11" / "2026/06/11" -> "2026-06-11". */
export function extractDate(lines: readonly OcrLine[]): string | null {
  for (const text of texts(lines)) {
    const iso = text.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    const named = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})/);
    if (named) {
      const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
      if (month) return `${named[3]}-${month}-${named[2].padStart(2, '0')}`;
    }
  }
  return null;
}

const CURRENCY_SYMBOLS: Record<string, string> = { '$': 'USD', 'US$': 'USD', 'NT$': 'TWD', '€': 'EUR', '¥': 'JPY', 'HK$': 'HKD', 'A$': 'AUD' };
const KNOWN_CODES = ['TWD', 'USD', 'JPY', 'EUR', 'AUD', 'HKD'];

/** First plausible "<currency> <amount>" pairing, preferring an explicit currency code or symbol. */
export function extractOriginalAmount(lines: readonly OcrLine[]): { currency: string; amount: string } | null {
  for (const text of texts(lines)) {
    const coded = text.match(new RegExp(`\\b(${KNOWN_CODES.join('|')})\\$?\\s?([\\d,]+\\.\\d{2})`));
    if (coded) return { currency: coded[1], amount: coded[2].replace(/,/g, '') };
    const symboled = text.match(/(NT\$|US\$|HK\$|A\$|[$€¥])\s?([\d,]+\.\d{2})/);
    if (symboled) {
      const currency = CURRENCY_SYMBOLS[symboled[1]];
      if (currency) return { currency, amount: symboled[2].replace(/,/g, '') };
    }
  }
  return null;
}

/**
 * Invoice number: label and value must be on the SAME OCR line. A vendor
 * receipt often prints two different numbers (an "invoice number" and a
 * "receipt number"), and long values can wrap onto a second line — reading
 * the line after a label risks silently picking up a truncated continuation
 * instead. A same-line match trades some misses (left blank, safe) for never
 * fabricating a wrong value (unsafe). "Invoice number" is tried before
 * "receipt number" since that is what this form's field is named for.
 */
export function extractInvoiceNumber(lines: readonly OcrLine[]): string | null {
  const all = texts(lines);
  const patterns = [/invoice number[:：]?\s*([A-Z0-9][A-Z0-9-]{5,})/i, /發票號碼[:：]?\s*([A-Z0-9][A-Z0-9-]{5,})/i, /receipt number[:：]?\s*([A-Z0-9][A-Z0-9-]{5,})/i, /收據號碼[:：]?\s*([A-Z0-9][A-Z0-9-]{5,})/i];
  for (const pattern of patterns) {
    for (const text of all) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * The buyer name on a "Bill to" line, or the line immediately following it.
 * Feeds directly into the name-consistency rule (see
 * server/domain/name-consistency-rules.ts), so a garbled read must come back
 * as "not found" rather than a wrong name: real testing against Vision OCR
 * found its per-line confidence only distinguishes badly at 0.5, but reliably
 * flags near-certain garbage at ~0.3, so lines below that are rejected here.
 */
const BUYER_NAME_MIN_CONFIDENCE = 0.4;
const BUYER_LABEL = /^(?:bill(?:ed)?\s+to|sold\s+to|ship(?:ped)?\s+to|customer(?:\s+name)?|買受人|收件人|客戶(?:姓名)?|購買人)[:：]?\s*$/i;
const BUYER_INLINE = /^(?:bill(?:ed)?\s+to|sold\s+to|ship(?:ped)?\s+to|customer(?:\s+name)?|買受人|收件人|客戶(?:姓名)?|購買人)[:：\s]+(.+)$/i;

function isPlausibleBuyerName(value: string, confidence: number): boolean {
  const trimmed = value.trim();
  if (!trimmed || confidence < BUYER_NAME_MIN_CONFIDENCE) return false;
  if (trimmed.includes('@') || /^\d/.test(trimmed)) return false;
  // Reject obvious address / city fragments OCR often puts under Bill to.
  if (/\d{2,}/.test(trimmed) || /street|road|avenue|區|路|街|號/i.test(trimmed)) return false;
  if (trimmed.length < 2 || trimmed.length > 80) return false;
  return true;
}

export function extractReceiptBuyerName(lines: readonly OcrLine[]): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    const label = lines[i].text.trim();
    const inline = label.match(BUYER_INLINE);
    if (inline && isPlausibleBuyerName(inline[1], lines[i].confidence)) {
      return inline[1].trim();
    }
    if (BUYER_LABEL.test(label)) {
      const next = lines[i + 1];
      const value = next?.text.trim();
      if (value && isPlausibleBuyerName(value, next.confidence)) return value;
    }
  }
  return null;
}

/**
 * Conservative billing-cycle read. Returns null when both annual and monthly
 * cues appear, or when the receipt never names a cadence.
 */
export function extractBillingCycle(lines: readonly OcrLine[]): 'annual' | 'monthly' | null {
  const blob = texts(lines).join(' ');
  const annual = /年費|年繳|年訂|annual(?:ly)?|yearly(?:\s+plan)?|billed\s+(?:yearly|annually)|per\s+year|\/\s*yr\b|12[\s-]?month/i.test(blob);
  const monthly = /月費|月繳|月訂|monthly|per\s+month|billed\s+monthly|\/\s*mo\b|every\s+month/i.test(blob);
  if (annual === monthly) return null;
  return annual ? 'annual' : 'monthly';
}

function parseNamedOrIsoDate(text: string): string | null {
  const iso = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const named = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})/);
  if (named) {
    const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (month) return `${named[3]}-${month}-${named[2].padStart(2, '0')}`;
  }
  return null;
}

/**
 * Subscription start/end when the receipt prints an explicit range
 * (e.g. "June 11, 2026 – June 11, 2027"). Does not invent an end date from
 * billing cycle alone.
 */
export function extractSubscriptionPeriod(lines: readonly OcrLine[]): { start: string; end: string } | null {
  const rangeSeparators = /[-–—~～至到]|to|through|thru/i;
  for (const text of texts(lines)) {
    if (!rangeSeparators.test(text) && !/訂閱|期間|period|valid|服務期間|subscription/i.test(text)) continue;
    // Collect date-shaped substrings in order; need exactly two distinct dates.
    const found: string[] = [];
    const isoGlobal = text.matchAll(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g);
    for (const match of isoGlobal) {
      found.push(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`);
    }
    if (found.length < 2) {
      const namedGlobal = text.matchAll(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})/g);
      for (const match of namedGlobal) {
        const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
        if (month) found.push(`${match[3]}-${month}-${match[2].padStart(2, '0')}`);
      }
    }
    if (found.length >= 2 && found[0] !== found[1]) {
      const start = found[0];
      const end = found[1];
      if (end >= start) return { start, end };
    }
  }
  // Label on one line, range spanning the next one or two lines.
  for (let i = 0; i < lines.length; i += 1) {
    const label = lines[i].text.trim();
    if (!/^(?:訂閱期間|服務期間|subscription(?:\s+period)?|valid(?:\s+(?:from|through))?|period)[:：]?\s*$/i.test(label)) continue;
    const combined = [lines[i + 1], lines[i + 2]].filter(Boolean).map((line) => line.text.trim()).join(' ');
    if (!combined) continue;
    const nested = extractSubscriptionPeriod([{ text: combined, confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } }]);
    if (nested) return nested;
    const single = parseNamedOrIsoDate(combined);
    // A lone start date under a period label is not enough — leave blank.
    if (single) return null;
  }
  return null;
}

function normalizeMatch(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

/**
 * Match receipt text against the approved-tool list. Short labels (Pi, v0)
 * only count as an exact line; longer labels may appear inside a line.
 * Multiple disjoint hits return null rather than guessing.
 */
export function extractApprovedAiTool(lines: readonly OcrLine[]): ApprovedAiTool | null {
  const lineTexts = texts(lines).map(normalizeMatch);
  const blob = lineTexts.join('\n');
  const matches = APPROVED_AI_TOOLS.filter((tool) => {
    const label = normalizeMatch(tool.label);
    if (!label) return false;
    if (label.length < 4) return lineTexts.includes(label);
    return blob.includes(label);
  });
  if (matches.length === 0) return null;
  const ranked = [...matches].sort((left, right) => right.label.length - left.label.length);
  const best = ranked[0];
  const bestLabel = normalizeMatch(best.label);
  const conflicting = ranked.slice(1).filter((tool) => !bestLabel.includes(normalizeMatch(tool.label)));
  return conflicting.length > 0 ? null : best;
}

export interface VendorReceiptCandidates {
  invoiceNumber: string | null;
  purchaseDate: string | null;
  originalCurrency: string | null;
  originalExpense: string | null;
  receiptBuyerName: string | null;
  billingCycle: 'annual' | 'monthly' | null;
  softwareName: string | null;
  companyName: string | null;
  subscriptionStartDate: string | null;
  subscriptionEndDate: string | null;
}

export function extractVendorReceiptCandidates(lines: readonly OcrLine[]): VendorReceiptCandidates {
  const amount = extractOriginalAmount(lines);
  const tool = extractApprovedAiTool(lines);
  const period = extractSubscriptionPeriod(lines);
  return {
    invoiceNumber: extractInvoiceNumber(lines),
    purchaseDate: extractDate(lines),
    originalCurrency: amount?.currency ?? null,
    originalExpense: amount?.amount ?? null,
    receiptBuyerName: extractReceiptBuyerName(lines),
    billingCycle: extractBillingCycle(lines),
    softwareName: tool?.label ?? null,
    companyName: tool?.company ?? null,
    subscriptionStartDate: period?.start ?? null,
    subscriptionEndDate: period?.end ?? null,
  };
}

export interface CardTransactionCandidates {
  convertedTwd: number | null;
}

/** The card-transaction screenshot's printed TWD amount — the one figure that actually verifies convertedTwd. */
export function extractCardTransactionCandidates(lines: readonly OcrLine[]): CardTransactionCandidates {
  for (const text of texts(lines)) {
    const match = text.match(/NT\$\s?([\d,]+)(?:\.\d{2})?/);
    if (match) return { convertedTwd: Number(match[1].replace(/,/g, '')) };
  }
  return { convertedTwd: null };
}
