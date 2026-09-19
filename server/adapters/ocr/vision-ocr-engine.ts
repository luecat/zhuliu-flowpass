import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { platform } from 'node:process';
import {
  DEFAULT_OCR_LANGUAGES,
  OcrError,
  type OcrEngine,
  type OcrBox,
  type OcrInput,
  type OcrLine,
  type OcrResult,
} from './ocr-engine';

/** Exit code the Swift helper uses for input it cannot decode as an image. */
const MEDIA_UNSUPPORTED_EXIT = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export interface SpawnedProcess {
  write(bytes: Uint8Array): void;
  /** Resolves with the collected stdout once the process exits cleanly. */
  result(): Promise<{ stdout: string; code: number }>;
  kill(): void;
}

export interface VisionOcrEngineOptions {
  binaryPath: string;
  timeoutMs?: number;
  /** Test seam; production spawns the Swift helper. */
  spawnImpl?: (binaryPath: string, args: readonly string[]) => SpawnedProcess;
  /** Test seam; production checks the real filesystem and platform. */
  probe?: () => Promise<boolean>;
}

function parseLines(stdout: string): OcrLine[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new OcrError('OCR_FAILED', 'recognizer returned malformed output');
  }
  const lines = (payload as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) throw new OcrError('OCR_FAILED', 'recognizer returned no lines');
  return lines.flatMap((entry): OcrLine[] => {
    const line = entry as Partial<OcrLine> & { box?: Partial<OcrBox> };
    if (typeof line.text !== 'string' || typeof line.confidence !== 'number') return [];
    const { x, y, width, height } = line.box ?? ({} as Partial<OcrBox>);
    if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) return [];
    return [{
      text: line.text,
      confidence: Math.min(1, Math.max(0, line.confidence)),
      box: { x: x as number, y: y as number, width: width as number, height: height as number },
    }];
  });
}

function defaultSpawn(binaryPath: string, args: readonly string[]): SpawnedProcess {
  const child = spawn(binaryPath, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  // Drain stderr so a chatty failure cannot fill the pipe buffer and hang the
  // child. Its content is diagnostic only; recognized text never goes there.
  child.stderr.resume();
  return {
    write(bytes) { child.stdin.end(Buffer.from(bytes)); },
    result() {
      return new Promise((resolve, reject) => {
        child.once('error', () => reject(new OcrError('OCR_ENGINE_UNAVAILABLE', 'recognizer could not start')));
        child.once('close', (code) => resolve({ stdout, code: code ?? 1 }));
      });
    },
    kill() { child.kill('SIGKILL'); },
  };
}

/**
 * macOS-only engine backed by the Vision framework. Hosts without it report
 * unavailable so a portable engine can take over; nothing above this boundary
 * depends on which implementation ran.
 */
export class VisionOcrEngine implements OcrEngine {
  public readonly id = 'macos-vision';
  private readonly binaryPath: string;
  private readonly timeoutMs: number;
  private readonly spawnImpl: (binaryPath: string, args: readonly string[]) => SpawnedProcess;
  private readonly probeImpl: () => Promise<boolean>;

  public constructor(options: VisionOcrEngineOptions) {
    this.binaryPath = options.binaryPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.probeImpl = options.probe ?? (async () => {
      if (platform !== 'darwin') return false;
      try {
        await access(this.binaryPath, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }

  public available(): Promise<boolean> {
    return this.probeImpl();
  }

  public async recognize(input: OcrInput): Promise<OcrResult> {
    if (input.bytes.byteLength > MAX_INPUT_BYTES) {
      throw new OcrError('OCR_INPUT_TOO_LARGE');
    }
    if (!(await this.available())) {
      throw new OcrError('OCR_ENGINE_UNAVAILABLE');
    }
    const languages = (input.languages ?? DEFAULT_OCR_LANGUAGES).join(',');
    const startedAt = Date.now();
    const child = this.spawnImpl(this.binaryPath, [input.mediaType, languages]);
    const timer = setTimeout(() => { child.kill(); }, this.timeoutMs);
    try {
      child.write(input.bytes);
      const { stdout, code } = await child.result();
      if (code === MEDIA_UNSUPPORTED_EXIT) throw new OcrError('OCR_MEDIA_UNSUPPORTED');
      if (code !== 0) {
        throw new OcrError(Date.now() - startedAt >= this.timeoutMs ? 'OCR_TIMEOUT' : 'OCR_FAILED');
      }
      return { lines: parseLines(stdout), engineId: this.id, durationMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  }
}
