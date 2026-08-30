import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
/** Multipart framing and the two small form fields are bounded separately at
 * the HTTP boundary before a framework parser is allowed to buffer a body. */
export const MAX_MULTIPART_BODY_BYTES = MAX_DOCUMENT_BYTES + 256 * 1024;
export const MAX_PDF_PAGES = 10;
export const MAX_IMAGE_PIXELS = 36_000_000;

export type DocumentMediaType = 'image/jpeg' | 'image/png' | 'application/pdf';

export type FileValidationCode =
  | 'file_too_large'
  | 'filename_invalid'
  | 'type_unsupported'
  | 'file_truncated'
  | 'pdf_encrypted'
  | 'pdf_too_many_pages'
  | 'image_too_large';

export class FileValidationError extends Error {
  constructor(readonly code: FileValidationCode, message = code) {
    super(message);
    this.name = 'FileValidationError';
  }
}

export interface ValidatedDocument {
  mediaType: DocumentMediaType;
  byteSize: number;
  contentSha256: string;
  pageCount?: number;
  width?: number;
  height?: number;
}

export type DocumentByteStream =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>;

function fail(code: FileValidationCode): never {
  throw new FileValidationError(code);
}

/**
 * Copy a browser/file stream into a bounded buffer. The declared Content-Length
 * is intentionally not consulted; the stream itself is the source of truth.
 */
export async function readLimitedDocumentStream(
  stream: DocumentByteStream,
  limit = MAX_DOCUMENT_BYTES,
): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Document limit is invalid');
  const chunks: Buffer[] = [];
  let total = 0;

  const append = (chunk: Uint8Array): void => {
    if (!chunk || typeof chunk !== 'object' || !ArrayBuffer.isView(chunk)) fail('file_truncated');
    total += chunk.byteLength;
    if (total > limit) fail('file_too_large');
    chunks.push(Buffer.from(chunk));
  };

  if (typeof (stream as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        append(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (Symbol.asyncIterator in Object(stream)) {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) append(chunk);
  } else {
    for (const chunk of stream as Iterable<Uint8Array>) append(chunk);
  }

  if (total === 0) fail('file_truncated');
  return Buffer.concat(chunks, total);
}

function readUInt32(data: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) fail('file_truncated');
  return data.readUInt32BE(offset);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(data: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < signature.length + 12 || !data.subarray(0, 8).equals(signature)) fail('type_unsupported');
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const compressedData: Buffer[] = [];
  while (offset < data.length) {
    const length = readUInt32(data, offset);
    const chunkEnd = offset + 12 + length;
    if (length > MAX_DOCUMENT_BYTES || chunkEnd > data.length) fail('file_truncated');
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) fail('type_unsupported');
    if (readUInt32(data, offset + 8 + length) !== crc32(Buffer.concat([Buffer.from(type, 'ascii'), data.subarray(offset + 8, offset + 8 + length)]))) fail('type_unsupported');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) fail('type_unsupported');
      width = readUInt32(data, offset + 8);
      height = readUInt32(data, offset + 12);
      bitDepth = data[offset + 16];
      colourType = data[offset + 17];
      const compression = data[offset + 18];
      const filter = data[offset + 19];
      interlace = data[offset + 20];
      if (!width || !height || ![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colourType) || compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) fail('type_unsupported');
      sawHeader = true;
    } else if (type === 'IDAT') {
      sawData = true;
      compressedData.push(data.subarray(offset + 8, offset + 8 + length));
    } else if (type === 'IEND') {
      if (length !== 0 || !sawHeader || !sawData || sawEnd || chunkEnd !== data.length) fail('file_truncated');
      sawEnd = true;
    }
    offset = chunkEnd;
    if (sawEnd) break;
  }
  if (!sawHeader || !sawData || !sawEnd) fail('file_truncated');
  if (width * height > MAX_IMAGE_PIXELS) fail('image_too_large');
  // Parsing the PNG container and dimensions is not enough: verify that the
  // image stream can actually be inflated and contains exactly one filtered
  // scanline for every row. Adam7 interlacing has a separate pass layout that
  // is deliberately rejected here until a bounded decoder is available.
  if (interlace !== 0) fail('type_unsupported');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colourType];
  if (!channels) fail('type_unsupported');
  const rowBytes = Math.ceil((width * bitDepth * channels) / 8);
  try {
    const decoded = inflateSync(Buffer.concat(compressedData));
    const expected = (rowBytes + 1) * height;
    if (decoded.length !== expected) fail('file_truncated');
  } catch (error) {
    if (error instanceof FileValidationError) throw error;
    fail('file_truncated');
  }
  return { width, height };
}

function isJpegSof(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function parseJpeg(data: Buffer): { width: number; height: number } {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) fail('type_unsupported');
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  let sawEntropy = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) fail('file_truncated');
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) fail('file_truncated');
    const marker = data[offset++];
    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0xda) {
      if (offset + 2 > data.length) fail('file_truncated');
      const scanLength = data.readUInt16BE(offset);
      if (scanLength < 2 || offset + scanLength > data.length) fail('file_truncated');
      offset += scanLength;
      while (offset + 1 < data.length) {
      if (data[offset] !== 0xff) {
          sawEntropy = true;
          offset += 1;
          continue;
        }
        const next = data[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (next === 0xd9) {
          offset += 2;
          sawEnd = true;
          break;
        }
        fail('file_truncated');
      }
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) fail('file_truncated');
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) fail('file_truncated');
    if (isJpegSof(marker)) {
      if (segmentLength < 7) fail('file_truncated');
      height = data.readUInt16BE(offset + 3);
      width = data.readUInt16BE(offset + 5);
      if (!width || !height) fail('type_unsupported');
    }
    offset += segmentLength;
  }
  if (!width || !height || !sawEnd || !sawEntropy) fail('file_truncated');
  if (width * height > MAX_IMAGE_PIXELS) fail('image_too_large');
  return { width, height };
}

function parsePdf(data: Buffer): number {
  const text = data.toString('latin1');
  if (!text.startsWith('%PDF-')) fail('type_unsupported');
  if (/(?:^|[\s<])\/Encrypt(?:[\s>/]|$)/.test(text)) fail('pdf_encrypted');
  if (!/%%EOF\s*$/.test(text)) fail('file_truncated');
  const objects = [...text.matchAll(/\b(\d+)\s+\d+\s+obj\b[\s\S]*?\bendobj\b/g)];
  if (objects.length === 0 || (text.match(/\bobj\b/g) ?? []).length !== (text.match(/\bendobj\b/g) ?? []).length) fail('file_truncated');
  const pages = [...text.matchAll(/\/Type\s*\/Page(?:\s|\/|>>)/g)].length;
  if (pages < 1) fail('file_truncated');
  const pageObjects = objects.filter((match) => /\/Type\s*\/Page(?:\s|\/|>>)/.test(match[0])).length;
  if (pageObjects !== pages) fail('file_truncated');
  if (pages > MAX_PDF_PAGES) fail('pdf_too_many_pages');
  return pages;
}

export function validateDocumentFilename(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 || name.includes('\0') || name.includes('/') || name.includes('\\') || name.split(/[\\/]/).some((segment) => segment === '..') || [...name].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) fail('filename_invalid');
}

export function validateDocumentBytes(data: Uint8Array, originalName = 'upload'): ValidatedDocument {
  validateDocumentFilename(originalName);
  const bytes = Buffer.from(data);
  if (bytes.length === 0) fail('file_truncated');
  if (bytes.length > MAX_DOCUMENT_BYTES) fail('file_too_large');

  let mediaType: DocumentMediaType;
  const details: { pageCount?: number; width?: number; height?: number } = {};
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mediaType = 'image/png';
    Object.assign(details, parsePng(bytes));
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mediaType = 'image/jpeg';
    Object.assign(details, parseJpeg(bytes));
  } else if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    mediaType = 'application/pdf';
    details.pageCount = parsePdf(bytes);
  } else {
    fail('type_unsupported');
  }
  return {
    mediaType,
    byteSize: bytes.length,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    ...details,
  };
}

/**
 * Run the bounded production decoders after the cheap, magic-byte gate. The
 * synchronous validator above remains useful for request-size and metadata
 * checks, while upload persistence always awaits this stronger path.
 *
 * Images are decoded to raw pixels through sharp (not merely metadata-read).
 * PDFs are parsed by the local `pdfinfo` decoder over stdin, so clear bytes are
 * never written to a temporary plaintext path. A missing/failed decoder fails
 * closed and is surfaced as an unsupported file rather than persisted.
 */
export async function validateDocumentBytesAsync(data: Uint8Array, originalName = 'upload'): Promise<ValidatedDocument> {
  const validated = validateDocumentBytes(data, originalName);
  const bytes = Buffer.from(data);
  if (validated.mediaType === 'image/png' || validated.mediaType === 'image/jpeg') {
    try {
      const sharpModule = await import('sharp');
      const image = sharpModule.default(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' });
      const metadata = await image.metadata();
      if (metadata.format !== (validated.mediaType === 'image/png' ? 'png' : 'jpeg') || metadata.width !== validated.width || metadata.height !== validated.height) fail('type_unsupported');
      const decoded = await image.raw().toBuffer({ resolveWithObject: true });
      if (decoded.info.width !== validated.width || decoded.info.height !== validated.height || decoded.data.byteLength === 0) fail('file_truncated');
    } catch (error) {
      if (error instanceof FileValidationError) throw error;
      fail('file_truncated');
    }
    return validated;
  }

  const decoder = spawnSync('pdfinfo', ['-'], {
    input: bytes,
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  if (decoder.error || decoder.status !== 0 || decoder.signal) fail('file_truncated');
  const pageMatch = /(?:^|\n)Pages:\s*(\d+)\s*(?:\n|$)/.exec(decoder.stdout);
  const decodedPages = pageMatch ? Number(pageMatch[1]) : NaN;
  if (!Number.isSafeInteger(decodedPages) || decodedPages < 1) fail('file_truncated');
  if (decodedPages > MAX_PDF_PAGES) fail('pdf_too_many_pages');
  return { ...validated, pageCount: decodedPages };
}
