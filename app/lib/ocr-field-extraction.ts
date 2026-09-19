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

export function extractReceiptBuyerName(lines: readonly OcrLine[]): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    const label = lines[i].text.trim();
    if (/^bill to$|^買受人$|^收件人$/i.test(label)) {
      const next = lines[i + 1];
      const value = next?.text.trim();
      // A name, not an email or a street address the next lines often carry.
      if (value && next.confidence >= BUYER_NAME_MIN_CONFIDENCE && !value.includes('@') && !/^\d/.test(value)) return value;
    }
  }
  return null;
}

export interface VendorReceiptCandidates {
  invoiceNumber: string | null;
  purchaseDate: string | null;
  originalCurrency: string | null;
  originalExpense: string | null;
  receiptBuyerName: string | null;
}

export function extractVendorReceiptCandidates(lines: readonly OcrLine[]): VendorReceiptCandidates {
  const amount = extractOriginalAmount(lines);
  return {
    invoiceNumber: extractInvoiceNumber(lines),
    purchaseDate: extractDate(lines),
    originalCurrency: amount?.currency ?? null,
    originalExpense: amount?.amount ?? null,
    receiptBuyerName: extractReceiptBuyerName(lines),
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
