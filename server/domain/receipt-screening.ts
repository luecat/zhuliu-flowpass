import { DEFAULT_OCR_LANGUAGES, type OcrEngine, type OcrMediaType } from '../adapters/ocr/ocr-engine';
import { getDocumentStorageForApplicant, listDocumentsForApplicant } from '../db/repositories/documents';
import { findBlockedReceiptTerm } from '../../shared/receipt-screening';
import { blockedTermsForCase } from './blocked-vendor-list';
import type { BlockedTermMatch } from '../../shared/blocked-terms';
import type { FlowPassDatabase } from '../db/connection';

const SCREENABLE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'application/pdf']);

export interface DocumentVaultReader {
  read(reference: { id: string; storageId: string; keyId: string }): Uint8Array;
}

/**
 * Re-reads the vendor receipt on the server at submission time and returns the
 * disqualifying term it finds, if any.
 *
 * The confirmation screen runs the same scan (shared/receipt-screening.ts) so
 * the applicant is stopped early, but that pass happens in the browser and the
 * purchase fields it fills can be retyped. Recognition is deliberately
 * repeated here instead: the receipt bytes are the one input the applicant
 * cannot edit, and a relay's product name ("Token Plan Individual") is printed
 * in line items that never reach a stored field at all.
 *
 * Returns null when there is nothing to screen — no receipt, an unsupported
 * media type, or no working OCR engine. That is deliberate: OCR is best-effort
 * everywhere in this system, and an engine outage must not start rejecting
 * eligible applications.
 */
export async function screenVendorReceipt(input: {
  database: FlowPassDatabase;
  documentVault: DocumentVaultReader;
  ocrEngine: OcrEngine;
  applicantId: string;
  caseId: string;
}): Promise<BlockedTermMatch | null> {
  const scope = { applicantId: input.applicantId };
  const receipt = listDocumentsForApplicant(input.database, scope, input.caseId)
    .find((document) => document.requirementKey === 'vendor_receipt' && document.status === 'ready');
  if (!receipt || !SCREENABLE_MEDIA_TYPES.has(receipt.mediaType)) return null;
  const storage = getDocumentStorageForApplicant(input.database, scope, receipt.id);
  if (!storage) return null;
  if (!(await input.ocrEngine.available())) return null;
  const bytes = input.documentVault.read({ id: storage.id, storageId: storage.storageId, keyId: storage.keyId });
  const recognized = await input.ocrEngine.recognize({
    bytes,
    mediaType: storage.mediaType as OcrMediaType,
    languages: DEFAULT_OCR_LANGUAGES,
  });
  return findBlockedReceiptTerm(recognized.lines, blockedTermsForCase(input.database, input.caseId));
}
