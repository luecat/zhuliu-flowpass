import { OcrAdapterError, parseOCRResult, type OCRResult, type OcrAdapter } from './ocr-contract';
export interface PaddleRunner { (bytes: Uint8Array, signal: AbortSignal): Promise<OCRResult>; }
/** Paddle is opt-in only after a no-network sandbox preflight. */
export class PaddleClient implements OcrAdapter {
  public constructor(private readonly runner: PaddleRunner, private readonly enabled = false, private readonly timeoutMs = 90_000) {}
  public async recognize(bytes: Uint8Array, signal?: AbortSignal): Promise<OCRResult> {
    if (!this.enabled) throw new OcrAdapterError('OCR_MANUAL_REVIEW');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try { return parseOCRResult(await this.runner(bytes, controller.signal)); } catch (error) { if (error instanceof OcrAdapterError && error.code === 'OCR_SANDBOX_FAILED') throw error; if (controller.signal.aborted) throw new OcrAdapterError('OCR_TIMEOUT'); throw new OcrAdapterError('OCR_UNAVAILABLE'); } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
