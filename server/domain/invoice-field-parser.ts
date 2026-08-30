import type { OCRLine } from '../adapters/ocr/ocr-contract';
export type InvoiceFieldName = 'invoice_number' | 'invoice_at' | 'purchase_at' | 'vendor_or_tool' | 'amount_minor' | 'currency';
export interface InvoiceFieldCandidate { fieldName: InvoiceFieldName; rawText: string; normalizedValue: string | null; confidence: number; sourcePage: number; sourceBox: OCRLine['boundingBox']; parserReasonCode: string; }
const datePattern = /(?:民國\s*)?(\d{2,4})[年\/-](\d{1,2})[月\/-](\d{1,2})日?(?:\s*(\d{1,2}):([0-5]\d))?/;
function dateCandidate(line: OCRLine): InvoiceFieldCandidate | null { const match = line.text.match(datePattern); if (!match) return null; const sourceYear = Number(match[1]); let year = sourceYear; if (year < 1911) year += 1911; const month = Number(match[2]); const day = Number(match[3]); const calendar = new Date(Date.UTC(year, month - 1, day)); const fieldName = /購買|purchase/i.test(line.text) ? 'purchase_at' : 'invoice_at'; if (!Number.isFinite(calendar.getTime()) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return { fieldName, rawText: line.text, normalizedValue: null, confidence: line.confidence, sourcePage: line.page, sourceBox: line.boundingBox, parserReasonCode: 'invalid_calendar_date' }; const normalized = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}${match[4] ? `T${String(Number(match[4])).padStart(2, '0')}:${match[5]}:00Z` : 'T00:00:00Z'}`; return { fieldName, rawText: line.text, normalizedValue: normalized, confidence: line.confidence, sourcePage: line.page, sourceBox: line.boundingBox, parserReasonCode: year !== sourceYear ? 'roc_year_converted' : match[4] ? 'date_time_pattern' : 'date_pattern' }; }
function candidate(fieldName: InvoiceFieldName, line: OCRLine, normalizedValue: string | null, reason: string): InvoiceFieldCandidate { return { fieldName, rawText: line.text, normalizedValue, confidence: line.confidence, sourcePage: line.page, sourceBox: line.boundingBox, parserReasonCode: reason }; }
export function parseInvoiceFields(lines: readonly OCRLine[]): InvoiceFieldCandidate[] {
  const results: InvoiceFieldCandidate[] = [];
  for (const line of lines) {
    const text = line.text.trim(); if (!text) continue;
    const date = dateCandidate(line); if (date) results.push(date);
    const invoice = text.match(/(?:發票號碼|發票號|invoice\s*(?:no|number)?)[：:\s]*([A-Z]{0,3}\s*\d{6,10})/i); if (invoice) results.push(candidate('invoice_number', line, invoice[1].replace(/\s+/g, ''), 'invoice_number_label'));
    const amount = text.match(/(?:NT\$?|TWD|USD|US\$|美元|金額|總計|合計)[：:\s]*([\d,]+(?:\.\d{1,2})?)/i); if (amount) { const numeric = Number(amount[1].replaceAll(',', '')); const minor = Number.isFinite(numeric) && Number.isSafeInteger(Math.round(numeric * 100)) ? String(Math.round(numeric * 100)) : null; results.push(candidate('amount_minor', line, minor, 'amount_label')); }
    if (/(?:USD|US\$|美元)/i.test(text)) results.push(candidate('currency', line, 'USD', 'currency_label'));
    else if (/(?:TWD|NT\$?|新臺幣|新台幣)/i.test(text)) results.push(candidate('currency', line, 'TWD', 'currency_label'));
    const vendor = text.match(/(?:商店|店家|廠商|vendor)[：:\s]*(.{2,80})/i); if (vendor) results.push(candidate('vendor_or_tool', line, vendor[1].trim(), 'vendor_label'));
  }
  return results;
}
