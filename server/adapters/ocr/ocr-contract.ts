export interface OCRLine { page: number; text: string; confidence: number; boundingBox: { x: number; y: number; width: number; height: number }; }
export interface OCRResult { engine: 'vision' | 'paddleocr'; engineVersion: string; languages: string[]; lines: OCRLine[]; durationMs: number; }
export type OCRFailureCode = 'OCR_TIMEOUT' | 'OCR_UNAVAILABLE' | 'OCR_SANDBOX_FAILED' | 'OCR_MANUAL_REVIEW';
export class OcrAdapterError extends Error { constructor(public readonly code: OCRFailureCode, message = code) { super(message); this.name = 'OcrAdapterError'; } }
export interface OcrAdapter { recognize(bytes: Uint8Array, signal?: AbortSignal): Promise<OCRResult>; }
export const MAX_OCR_INPUT_BYTES = 12 * 1024 * 1024;

export function parseOCRResult(value: unknown): OCRResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
  const record = value as Record<string, unknown>;
  if (record.engine !== 'vision' && record.engine !== 'paddleocr') throw new OcrAdapterError('OCR_SANDBOX_FAILED');
  if (typeof record.engineVersion !== 'string' || record.engineVersion.length === 0 || record.engineVersion.length > 128) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
  if (!Array.isArray(record.languages) || record.languages.length > 8 || record.languages.some((language) => typeof language !== 'string' || language.length > 32)) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
  if (!Array.isArray(record.lines) || record.lines.length > 20_000) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
  const lines = record.lines.map((line): OCRLine => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
    const item = line as Record<string, unknown>; const box = item.boundingBox;
    if (!Number.isSafeInteger(item.page) || (item.page as number) < 1 || typeof item.text !== 'string' || item.text.length > 8_192 || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 || !box || typeof box !== 'object' || Array.isArray(box)) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
    const bounds = box as Record<string, unknown>;
    if (['x', 'y', 'width', 'height'].some((key) => typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]) || (bounds[key] as number) < 0 || (bounds[key] as number) > 1)) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
    if ((bounds.x as number) + (bounds.width as number) > 1 || (bounds.y as number) + (bounds.height as number) > 1 || (item.page as number) > 10) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
    return { page: item.page as number, text: item.text, confidence: item.confidence, boundingBox: { x: bounds.x as number, y: bounds.y as number, width: bounds.width as number, height: bounds.height as number } };
  });
  if (typeof record.durationMs !== 'number' || !Number.isSafeInteger(record.durationMs) || record.durationMs < 0 || record.durationMs > 90_000) throw new OcrAdapterError('OCR_SANDBOX_FAILED');
  return { engine: record.engine, engineVersion: record.engineVersion, languages: record.languages as string[], lines, durationMs: record.durationMs };
}
