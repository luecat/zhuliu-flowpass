/**
 * Contract for GET /api/v1/documents/:documentId/ocr — the fixed handoff
 * point between backend (recognizes text) and frontend (interprets it into
 * form fields; see app/lib/ocr-field-extraction.ts). Neither side should
 * change this shape without the other: the backend never adds interpreted
 * fields here (see server/adapters/ocr/ocr-engine.ts's boundary comment),
 * and the frontend never expects fields beyond what's listed.
 */

/** Normalized box, origin bottom-left, each value in [0, 1] — same convention as the Vision/tesseract engines. */
export interface OcrLineBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLineContract {
  text: string;
  confidence: number;
  box: OcrLineBox;
}

export interface DocumentOcrResponseData {
  ocr: {
    lines: readonly OcrLineContract[];
    engineId: string;
    durationMs: number;
  } | null;
  /**
   * The denylist verdict for this document, decided on the server against the
   * program's own softwareBlacklist. The screen renders it; it never re-judges
   * the text itself, so the applicant and the submission check are answering to
   * the same list. Null means nothing on the list appeared.
   */
  blocked: { term: string; matched: string } | null;
}
