import { matchBlockedTerm, type BlockedTermMatch } from './blocked-terms';
import type { OcrLineContract } from './ocr-contract';

/**
 * First denylisted term anywhere in the recognized receipt — not just in the
 * fields the form keeps. A relay shop's receipt names its own product
 * ("Token Plan Individual") in the line-item rows, and a vendor's name can sit
 * in a header the field extractors deliberately skip, so the whole text is
 * scanned against the program's list.
 *
 * Low-confidence lines are ignored: a garbled read must not disqualify an
 * eligible purchase.
 */
const BLOCKED_TERM_MIN_CONFIDENCE = 0.4;

export function findBlockedReceiptTerm(
  lines: readonly OcrLineContract[],
  terms: readonly string[],
): BlockedTermMatch | null {
  for (const line of lines) {
    if (line.confidence < BLOCKED_TERM_MIN_CONFIDENCE) continue;
    const match = matchBlockedTerm(line.text, terms);
    if (match) return match;
  }
  return null;
}
