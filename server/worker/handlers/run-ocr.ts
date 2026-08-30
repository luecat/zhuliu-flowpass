import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { FlowPassDatabase } from '../../db/connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import { insertEncryptedDocumentFieldForSystem, insertEncryptedOcrRawPayloadForSystem, insertEncryptedOcrRunForSystem } from '../../db/repositories/documents';
import type { DurableJob, WorkerScope } from '../../db/repositories/jobs';
import { runOcr, type OcrServiceOptions } from '../../domain/ocr-service';
import type { DocumentVault } from '../../services/document-vault';
export async function runOcrJob(job: DurableJob, scope: WorkerScope, options: { database: FlowPassDatabase; crypto: FieldCrypto; ocr: OcrServiceOptions; vault?: DocumentVault; bytes?: Uint8Array; clock?: () => Date; idGenerator?: () => string }): Promise<{ ocrRunId: string; fieldCount: number; manualReview: boolean }> {
  if (job.jobType !== 'ocr' || !job.payload || typeof job.payload !== 'object' || typeof (job.payload as Record<string, unknown>).documentId !== 'string') throw new Error('unsupported OCR job');
  const documentId = (job.payload as { documentId: string }).documentId;
  const source = options.database.prepare('SELECT id, storage_id, key_id, status FROM documents WHERE id = ?').get(documentId) as { id: string; storage_id: string; key_id: string; status: string } | undefined;
  if (!source || source.status !== 'ready') throw new Error('OCR document is unavailable');
  const bytes = options.bytes ?? (options.vault ? options.vault.read({ id: source.id, storageId: source.storage_id, keyId: source.key_id }) : (() => { throw new Error('OCR vault is unavailable'); })());
  const id = options.idGenerator ?? uuidv7; const now = (options.clock ?? (() => new Date()))().toISOString(); const result = await runOcr(bytes, options.ocr); const primaryRunId = result.primary ? id() : null; const fallbackRunId = result.fallback ? id() : null; const persistedPrimaryRunId = primaryRunId ?? id(); const persistedFallbackRunId = fallbackRunId ?? id(); const selected = result.selected; const selectedRunId = selected?.engine === 'paddleocr' ? persistedFallbackRunId : persistedPrimaryRunId; const ocrRunId = selectedRunId ?? id();
  options.database.transaction(() => {
    if (result.primary || result.primaryFailureCode) { insertEncryptedOcrRunForSystem(options.database, { systemId: scope.workerId }, options.crypto, { id: persistedPrimaryRunId, documentId, engine: 'vision', engineVersion: result.primary?.engineVersion ?? 'unavailable', status: result.primary ? (result.selected?.engine === 'vision' && result.manualReview ? 'manual_review' : 'completed') : 'failed', result: null, resultSha256: result.primary ? createHash('sha256').update(JSON.stringify(result.primary)).digest('hex') : null, failureCode: result.primaryFailureCode ?? (result.selected?.engine === 'vision' && result.manualReview ? 'OCR_MANUAL_REVIEW' : null), startedAt: now, finishedAt: now, createdAt: now }); if (result.primary) insertEncryptedOcrRawPayloadForSystem(options.database, { systemId: scope.workerId }, options.crypto, { id: id(), ocrRunId: persistedPrimaryRunId, payload: JSON.stringify(result.primary), createdAt: now }); }
    if (result.fallback || result.fallbackFailureCode) { insertEncryptedOcrRunForSystem(options.database, { systemId: scope.workerId }, options.crypto, { id: persistedFallbackRunId, documentId, engine: 'paddleocr', engineVersion: result.fallback?.engineVersion ?? 'unavailable', status: result.fallback ? (result.selected?.engine === 'paddleocr' && result.manualReview ? 'manual_review' : 'completed') : 'failed', result: null, resultSha256: result.fallback ? createHash('sha256').update(JSON.stringify(result.fallback)).digest('hex') : null, failureCode: result.fallbackFailureCode ?? (result.selected?.engine === 'paddleocr' && result.manualReview ? 'OCR_MANUAL_REVIEW' : null), startedAt: now, finishedAt: now, createdAt: now }); if (result.fallback) insertEncryptedOcrRawPayloadForSystem(options.database, { systemId: scope.workerId }, options.crypto, { id: id(), ocrRunId: persistedFallbackRunId, payload: JSON.stringify(result.fallback), createdAt: now }); }
    if (!selected) insertEncryptedOcrRunForSystem(options.database, { systemId: scope.workerId }, options.crypto, { id: ocrRunId, documentId, engine: 'manual', engineVersion: 'manual-review', status: 'manual_review', result: null, resultSha256: null, failureCode: result.primaryFailureCode ?? result.fallbackFailureCode ?? 'OCR_MANUAL_REVIEW', startedAt: now, finishedAt: now, createdAt: now });
    if (selected) {
      const bestByField = new Map<string, typeof result.candidates[number]>();
      for (const field of result.candidates) {
        const previous = bestByField.get(field.fieldName);
        if (!previous || (field.normalizedValue !== null && previous.normalizedValue === null) || field.confidence > previous.confidence) bestByField.set(field.fieldName, field);
      }
      for (const field of bestByField.values()) insertEncryptedDocumentFieldForSystem(options.database, { systemId: scope.workerId }, options.crypto, { id: id(), documentId, fieldName: field.fieldName, originalValue: field.rawText, normalizedValue: field.normalizedValue, confidence: field.confidence, sourceOcrRunId: selectedRunId, sourcePage: field.sourcePage, sourceBox: JSON.stringify(field.sourceBox), parserReasonCode: field.parserReasonCode, createdAt: now });
    }
  })();
  return { ocrRunId, fieldCount: result.candidates.length, manualReview: result.manualReview };
}
