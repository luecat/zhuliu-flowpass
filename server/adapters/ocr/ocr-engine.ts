/**
 * Text recognition boundary. Engines only turn an image into text lines; they
 * never interpret a receipt, decide a field's meaning, or judge a case. Callers
 * own every rule applied to the returned text.
 */

export type OcrErrorCode =
  | 'OCR_ENGINE_UNAVAILABLE'
  | 'OCR_MEDIA_UNSUPPORTED'
  | 'OCR_INPUT_TOO_LARGE'
  | 'OCR_TIMEOUT'
  | 'OCR_FAILED';

export class OcrError extends Error {
  public constructor(public readonly code: OcrErrorCode, message: string = code) {
    super(message);
    this.name = 'OcrError';
  }
}

export type OcrMediaType = 'image/jpeg' | 'image/png' | 'application/pdf';

/** Normalized box, origin bottom-left, each value in [0, 1]. */
export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLine {
  text: string;
  /** Engine-reported confidence in [0, 1]. */
  confidence: number;
  box: OcrBox;
}

export interface OcrResult {
  lines: readonly OcrLine[];
  /** Identifies which implementation produced this result, for audit records. */
  engineId: string;
  durationMs: number;
}

export interface OcrInput {
  bytes: Uint8Array;
  mediaType: OcrMediaType;
  /** BCP-47 tags, most likely first. */
  languages?: readonly string[];
}

export interface OcrEngine {
  readonly id: string;
  /** Resolves false when the host cannot run this engine, so callers can fall back. */
  available(): Promise<boolean>;
  recognize(input: OcrInput): Promise<OcrResult>;
}

export const DEFAULT_OCR_LANGUAGES = ['zh-Hant', 'en-US'] as const;
