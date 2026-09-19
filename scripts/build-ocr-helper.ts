import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform } from 'node:process';
import { runtimeConfig } from '../server/config/runtime-config';
import { ocrHelperBinaryPath } from '../server/config/ocr-helper-path';

/**
 * One-time local build for the macOS Vision OCR helper (see
 * server/adapters/ocr/vision/flowpass-ocr.swift). Not yet part of
 * package:release — see docs/2026-09-19-憑證比對自動化-開發企劃.md section 5 —
 * so this script exists to let OCR run against a dev server today.
 *
 *   npm run build:ocr-helper
 */
export function buildOcrHelper(): { built: boolean; path: string | null; reason?: string } {
  if (platform !== 'darwin') {
    return { built: false, path: null, reason: 'macOS only (Vision framework); cross-platform tesseract.js engine is not implemented yet.' };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, '..', 'server', 'adapters', 'ocr', 'vision', 'flowpass-ocr.swift');
  if (!existsSync(source)) return { built: false, path: null, reason: 'flowpass-ocr.swift not found; is the OCR adapter still present?' };
  const output = ocrHelperBinaryPath(runtimeConfig.dataRoot);
  mkdirSync(dirname(output), { recursive: true });
  execFileSync('swiftc', ['-O', source, '-o', output], { stdio: 'inherit' });
  chmodSync(output, 0o755);
  return { built: true, path: output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildOcrHelper();
  if (!result.built) {
    console.log(result.reason);
  } else {
    console.log(`Built OCR helper at ${result.path}. The public dev server will use it automatically on the next start.`);
  }
}
