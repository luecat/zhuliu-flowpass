import type { OcrAdapter, OCRResult, OCRFailureCode } from '../adapters/ocr/ocr-contract';
import { parseInvoiceFields, type InvoiceFieldCandidate } from './invoice-field-parser';
export interface OcrServiceOptions { vision: OcrAdapter; paddle?: OcrAdapter; forceFallback?: boolean; }
export interface OcrServiceResult { primary: OCRResult | null; fallback: OCRResult | null; selected: OCRResult | null; primaryFailureCode: OCRFailureCode | null; fallbackFailureCode: OCRFailureCode | null; candidates: InvoiceFieldCandidate[]; manualReview: boolean; }
const REQUIRED_FIELDS: readonly InvoiceFieldCandidate['fieldName'][] = ['invoice_number', 'invoice_at', 'purchase_at', 'vendor_or_tool', 'amount_minor', 'currency'];
export async function runOcr(bytes: Uint8Array, options: OcrServiceOptions): Promise<OcrServiceResult> {
  let primary: OCRResult | null = null; let fallback: OCRResult | null = null;
  let primaryFailureCode: OCRFailureCode | null = null;
  let fallbackFailureCode: OCRFailureCode | null = null;
  try { primary = await options.vision.recognize(bytes); } catch (error) { primaryFailureCode = error instanceof Error && 'code' in error ? (error as { code: OCRFailureCode }).code : 'OCR_UNAVAILABLE'; }
  const lines = primary?.lines ?? [];
  const lowConfidence = ['invoice_number', 'invoice_at', 'purchase_at', 'vendor_or_tool', 'amount_minor', 'currency'].some((name) => { const match = parseInvoiceFields(lines).find((item) => item.fieldName === name); return !match || match.confidence < 0.65; });
  const shouldFallback = options.forceFallback === true || !primary || lines.reduce((sum, line) => sum + line.text.replace(/\s/g, '').length, 0) < 20 || lowConfidence;
  if (shouldFallback && options.paddle) { try { fallback = await options.paddle.recognize(bytes); } catch (error) { fallbackFailureCode = error instanceof Error && 'code' in error ? (error as { code: OCRFailureCode }).code : 'OCR_UNAVAILABLE'; } }
  // Once fallback was requested and produced a result, select it as the
  // authoritative candidate set. Comparing line counts can retain a sparse or
  // low-confidence Vision result even when Paddle found the required fields.
  const selected = fallback ?? primary;
  const candidates = selected ? parseInvoiceFields(selected.lines) : [];
  const manualReview = !selected || REQUIRED_FIELDS.some((fieldName) => {
    const matches = candidates.filter((candidate) => candidate.fieldName === fieldName);
    return matches.length === 0 || matches.every((candidate) => candidate.normalizedValue === null) || Math.max(...matches.map((candidate) => candidate.confidence)) < 0.65;
  });
  return { primary, fallback, selected, primaryFailureCode, fallbackFailureCode, candidates, manualReview };
}
