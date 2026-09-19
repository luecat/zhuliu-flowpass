import { describe, expect, it } from 'vitest';
import { OcrError } from './ocr-engine';
import { VisionOcrEngine, type SpawnedProcess } from './vision-ocr-engine';

function fakeSpawn(outcome: { stdout: string; code: number }, seen?: { args: string[]; bytes: Uint8Array[] }): (binaryPath: string, args: readonly string[]) => SpawnedProcess {
  return (_binaryPath, args) => {
    if (seen) seen.args = [...args];
    return {
      write(bytes) { seen?.bytes.push(bytes); },
      result: async () => outcome,
      kill() {},
    };
  };
}

const line = { text: '買受人：陳美玲', confidence: 1, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 } };

function engine(outcome: { stdout: string; code: number }, seen?: { args: string[]; bytes: Uint8Array[] }) {
  return new VisionOcrEngine({ binaryPath: '/nonexistent/flowpass-ocr', spawnImpl: fakeSpawn(outcome, seen), probe: async () => true });
}

describe('VisionOcrEngine', () => {
  it('returns recognized lines with the engine id', async () => {
    const result = await engine({ stdout: JSON.stringify({ lines: [line] }), code: 0 })
      .recognize({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' });
    expect(result.lines).toEqual([line]);
    expect(result.engineId).toBe('macos-vision');
  });

  it('passes the media type and languages to the recognizer', async () => {
    const seen = { args: [] as string[], bytes: [] as Uint8Array[] };
    await engine({ stdout: '{"lines":[]}', code: 0 }, seen)
      .recognize({ bytes: new Uint8Array([9]), mediaType: 'application/pdf', languages: ['ja-JP'] });
    expect(seen.args).toEqual(['application/pdf', 'ja-JP']);
    expect(seen.bytes).toEqual([new Uint8Array([9])]);
  });

  it('reports unsupported media separately from a generic failure', async () => {
    await expect(engine({ stdout: '', code: 3 }).recognize({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }))
      .rejects.toMatchObject({ code: 'OCR_MEDIA_UNSUPPORTED' });
    await expect(engine({ stdout: '', code: 1 }).recognize({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }))
      .rejects.toMatchObject({ code: 'OCR_FAILED' });
  });

  it('rejects malformed recognizer output instead of returning empty text', async () => {
    await expect(engine({ stdout: 'not json', code: 0 }).recognize({ bytes: new Uint8Array([1]), mediaType: 'image/png' }))
      .rejects.toBeInstanceOf(OcrError);
  });

  it('drops malformed lines but keeps well-formed ones', async () => {
    const result = await engine({ stdout: JSON.stringify({ lines: [line, { text: 'x' }, { confidence: 1 }] }), code: 0 })
      .recognize({ bytes: new Uint8Array([1]), mediaType: 'image/png' });
    expect(result.lines).toEqual([line]);
  });

  it('reports unavailable rather than spawning when the host cannot run it', async () => {
    const unavailable = new VisionOcrEngine({
      binaryPath: '/nonexistent/flowpass-ocr',
      probe: async () => false,
      spawnImpl: () => { throw new Error('must not spawn'); },
    });
    await expect(unavailable.recognize({ bytes: new Uint8Array([1]), mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'OCR_ENGINE_UNAVAILABLE' });
  });

  it('refuses oversized input before starting a process', async () => {
    const tooBig = new VisionOcrEngine({
      binaryPath: '/nonexistent/flowpass-ocr',
      probe: async () => true,
      spawnImpl: () => { throw new Error('must not spawn'); },
    });
    await expect(tooBig.recognize({ bytes: new Uint8Array(26 * 1024 * 1024), mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'OCR_INPUT_TOO_LARGE' });
  });
});
