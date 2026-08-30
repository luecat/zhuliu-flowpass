import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { FileValidationError, MAX_DOCUMENT_BYTES, MAX_IMAGE_PIXELS, MAX_PDF_PAGES, readLimitedDocumentStream, validateDocumentBytes, validateDocumentBytesAsync } from './file-validation';

function chunk(type: string, body: Buffer): Buffer {
  let crc = 0xffffffff;
  for (const value of Buffer.concat([Buffer.from(type), body])) { crc ^= value; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, Buffer.from(type), body, checksum]);
}

function png(width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  // zlib stream decodes to one filter byte plus three RGB bytes for 1x1.
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', Buffer.from([120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1])), chunk('IEND', Buffer.alloc(0))]);
}

function jpeg(width = 1, height = 1): Buffer {
  const sof = Buffer.alloc(15); sof.writeUInt16BE(15, 0); sof[2] = 8; sof.writeUInt16BE(height, 3); sof.writeUInt16BE(width, 5); sof[7] = 1; sof[8] = 1; sof[9] = 0x11; sof[10] = 0;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0]), sof, Buffer.from([0xff, 0xda, 0, 2, 0x11]), Buffer.from([0xff, 0xd9])]);
}

function pdf(pageCount: number, encrypted = false): Buffer {
  const pages = Array.from({ length: pageCount }, (_, index) => `${index + 1} 0 obj\n<< /Type /Page >>\nendobj`).join('\n');
  return Buffer.from(`%PDF-1.7\n${encrypted ? '<< /Encrypt 7 0 R >>\n' : ''}${pages}\n%%EOF\n`, 'latin1');
}

function decodablePdf(): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) { offsets.push(Buffer.byteLength(body)); body += object; }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('document file validation', () => {
  it('accepts magic-byte parsed JPEG, PNG, and non-encrypted PDF while ignoring extensions and declared MIME', () => {
    expect(validateDocumentBytes(jpeg(), 'invoice.txt')).toMatchObject({ mediaType: 'image/jpeg', width: 1, height: 1 });
    expect(validateDocumentBytes(png(), 'invoice.pdf')).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 });
    expect(validateDocumentBytes(pdf(1), 'anything.bin')).toMatchObject({ mediaType: 'application/pdf', pageCount: 1 });
  });

  it('rejects a stream only after the actual bytes cross the 12 MiB limit', async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent === 0) controller.enqueue(Buffer.alloc(MAX_DOCUMENT_BYTES - 1)); else if (sent === 1) { controller.enqueue(Buffer.alloc(2)); controller.close(); } sent += 1; } });
    await expect(readLimitedDocumentStream(stream)).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('enforces page, pixel, encryption, truncation, and filename path limits', () => {
    expect(() => validateDocumentBytes(pdf(MAX_PDF_PAGES + 1))).toThrowError(new FileValidationError('pdf_too_many_pages'));
    expect(() => validateDocumentBytes(pdf(1, true))).toThrowError(new FileValidationError('pdf_encrypted'));
    expect(() => validateDocumentBytes(png(6001, 6000))).toThrowError(new FileValidationError('image_too_large'));
    expect(() => validateDocumentBytes(Buffer.from('%PDF-1.7\n%%EOF', 'latin1'))).toThrowError(new FileValidationError('file_truncated'));
    expect(() => validateDocumentBytes(Buffer.from('not-a-file'), '../invoice.pdf')).toThrowError(new FileValidationError('filename_invalid'));
    expect(() => validateDocumentBytes(Buffer.alloc(MAX_DOCUMENT_BYTES + 1), 'oversize.bin')).toThrowError(new FileValidationError('file_too_large'));
    expect(MAX_IMAGE_PIXELS).toBe(36_000_000);
  });

  it('rejects a PNG whose IDAT cannot be decoded and a JPEG with no entropy scan', () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
    const invalidPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', Buffer.from([1])), chunk('IEND', Buffer.alloc(0))]);
    expect(() => validateDocumentBytes(invalidPng)).toThrowError(new FileValidationError('file_truncated'));
    expect(() => validateDocumentBytes(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 1, 0, 1, 1, 1, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toThrowError(new FileValidationError('file_truncated'));
  });

  it('requires the production image/PDF decoders after the structural gate', async () => {
    const sharp = (await import('sharp')).default;
    const validJpeg = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer();
    await expect(validateDocumentBytesAsync(validJpeg, 'photo.jpg')).resolves.toMatchObject({ mediaType: 'image/jpeg', width: 1, height: 1 });
    await expect(validateDocumentBytesAsync(decodablePdf(), 'invoice.pdf')).resolves.toMatchObject({ mediaType: 'application/pdf', pageCount: 1 });
    await expect(validateDocumentBytesAsync(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'broken.jpg')).rejects.toMatchObject({ code: 'file_truncated' });
  });
});
