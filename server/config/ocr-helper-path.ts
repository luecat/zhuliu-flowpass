import { join } from 'node:path';

/** Stable local build output, shared by scripts/build-ocr-helper.ts and bootstrap.ts. */
export function ocrHelperBinaryPath(dataRoot: string): string {
  return join(dataRoot, 'bin', 'flowpass-ocr');
}
