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
}
