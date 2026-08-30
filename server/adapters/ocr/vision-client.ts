import { spawn } from 'node:child_process';
import { MAX_OCR_INPUT_BYTES, OcrAdapterError, parseOCRResult, type OCRResult, type OcrAdapter } from './ocr-contract';
export interface VisionRunner { (bytes: Uint8Array, signal: AbortSignal): Promise<OCRResult>; }
export class VisionClient implements OcrAdapter {
  public constructor(private readonly runner: VisionRunner, private readonly timeoutMs = 90_000) {}
  public async recognize(bytes: Uint8Array, signal?: AbortSignal): Promise<OCRResult> {
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return parseOCRResult(await this.runner(bytes, controller.signal)); } catch (error) { if (error instanceof OcrAdapterError && error.code === 'OCR_SANDBOX_FAILED') throw error; if (controller.signal.aborted) throw new OcrAdapterError('OCR_TIMEOUT'); throw new OcrAdapterError('OCR_UNAVAILABLE'); } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}

/** Spawn the signed stdin/stdout helper; the caller owns its trusted path. */
export function createVisionProcessRunner(executablePath: string): VisionRunner {
  return (bytes, signal) => new Promise<OCRResult>((resolve, reject) => {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_OCR_INPUT_BYTES) { reject(new OcrAdapterError('OCR_SANDBOX_FAILED')); return; }
    const child = spawn(executablePath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const output: Buffer[] = []; let total = 0; let settled = false;
    const finish = (error?: Error, result?: OCRResult) => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); if (error) reject(error); else resolve(result!); };
    const onAbort = () => { child.kill('SIGKILL'); finish(new OcrAdapterError('OCR_TIMEOUT')); };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { total += chunk.byteLength; if (total > 2 * 1024 * 1024) { child.kill('SIGKILL'); finish(new OcrAdapterError('OCR_SANDBOX_FAILED')); } else output.push(chunk); });
    child.on('error', () => finish(new OcrAdapterError('OCR_UNAVAILABLE')));
    child.stdin.on('error', () => finish(new OcrAdapterError('OCR_SANDBOX_FAILED')));
    child.on('close', (code) => { if (code !== 0) return finish(new OcrAdapterError('OCR_SANDBOX_FAILED')); try { finish(undefined, parseOCRResult(JSON.parse(Buffer.concat(output).toString('utf8')))); } catch (error) { finish(error instanceof OcrAdapterError ? error : new OcrAdapterError('OCR_SANDBOX_FAILED')); } });
    child.stdin.end(Buffer.from(bytes));
  });
}
