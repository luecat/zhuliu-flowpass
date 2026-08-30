import { v7 as uuidv7 } from 'uuid';
import type { FieldCrypto } from '../crypto/field-crypto';
import type { FlowPassDatabase } from '../db/connection';
import { appendEncryptedAuditLog } from '../db/repositories/audit';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RAW_OCR_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 36_500;

interface RetentionPolicy {
  legalHold?: unknown;
  legal_hold?: unknown;
  rawOcrRetentionDays?: unknown;
  raw_ocr_retention_days?: unknown;
}

interface RawPayloadRow {
  id: string;
  document_id: string;
  case_id: string;
  closed_at: string | null;
  retention_policy_json: string;
}

export interface OcrRetentionResult {
  examined: number;
  purged: number;
  skippedLegalHold: number;
  skippedNotDue: number;
}

export interface OcrRetentionOptions {
  database: FlowPassDatabase;
  crypto: FieldCrypto;
  now?: Date;
  actorId?: string;
  requestId?: string;
  idGenerator?: () => string;
  defaultRetentionDays?: number;
}

function parsePolicy(value: string): RetentionPolicy {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RetentionPolicy;
  } catch {
    // Invalid policy is treated as the conservative default rather than as an
    // instruction to delete data early.
  }
  return {};
}

function isLegalHold(policy: RetentionPolicy): boolean {
  return policy.legalHold === true || policy.legal_hold === true;
}

function retentionDays(policy: RetentionPolicy, fallback: number): number {
  const candidate = policy.rawOcrRetentionDays ?? policy.raw_ocr_retention_days;
  const days = typeof candidate === 'number' ? candidate : typeof candidate === 'string' && candidate.trim() ? Number(candidate) : fallback;
  if (!Number.isSafeInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) return fallback;
  return days;
}

function assertRetentionDays(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RETENTION_DAYS) throw new Error('raw OCR retention days are invalid');
}

/**
 * Removes only the separately encrypted OCR envelope after case closure. The
 * immutable OCR run keeps its engine/status/hash metadata, while normalized
 * values with an effective review remain available for the case retention
 * period. Every purge is represented by a fixed-code audit tombstone.
 */
export function purgeExpiredRawOcr(options: OcrRetentionOptions): OcrRetentionResult {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('retention clock is invalid');
  const fallbackDays = options.defaultRetentionDays ?? DEFAULT_RAW_OCR_RETENTION_DAYS;
  assertRetentionDays(fallbackDays);
  const actorId = options.actorId ?? 'retention-worker';
  const requestId = options.requestId ?? `retention:${now.toISOString()}`;
  const idGenerator = options.idGenerator ?? uuidv7;
  const rows = options.database.prepare(`
    SELECT p.id, d.id AS document_id, c.id AS case_id, c.closed_at,
           pc.retention_policy_json
    FROM ocr_raw_payloads p
    JOIN ocr_runs r ON r.id = p.ocr_run_id
    JOIN documents d ON d.id = r.document_id
    JOIN cases c ON c.id = d.case_id
    JOIN program_cycles pc ON pc.id = c.program_cycle_id
    WHERE p.payload_enc IS NOT NULL AND p.purged_at IS NULL AND c.closed_at IS NOT NULL
    ORDER BY p.created_at ASC, p.id ASC
  `).all() as RawPayloadRow[];

  const result: OcrRetentionResult = { examined: rows.length, purged: 0, skippedLegalHold: 0, skippedNotDue: 0 };
  for (const row of rows) {
    const closedAtMs = row.closed_at ? Date.parse(row.closed_at) : Number.NaN;
    if (!Number.isFinite(closedAtMs)) {
      result.skippedNotDue += 1;
      continue;
    }
    const policy = parsePolicy(row.retention_policy_json);
    if (isLegalHold(policy)) {
      result.skippedLegalHold += 1;
      continue;
    }
    if (closedAtMs + retentionDays(policy, fallbackDays) * DAY_MS > now.getTime()) {
      result.skippedNotDue += 1;
      continue;
    }

    const purgedAt = now.toISOString();
    const changed = options.database.transaction(() => {
      const current = options.database.prepare('SELECT payload_enc FROM ocr_raw_payloads WHERE id = ? AND purged_at IS NULL').get(row.id) as { payload_enc: string | null } | undefined;
      if (!current?.payload_enc) return false;
      options.database.prepare('UPDATE ocr_raw_payloads SET payload_enc = NULL, purged_at = ? WHERE id = ? AND purged_at IS NULL').run(purgedAt, row.id);
      options.database.prepare(`
        UPDATE document_fields
        SET original_value_enc = NULL,
            source_box_enc = NULL,
            normalized_value_enc = CASE WHEN effective_review_id IS NULL THEN NULL ELSE normalized_value_enc END,
            normalized_value_hmac = CASE WHEN effective_review_id IS NULL THEN NULL ELSE normalized_value_hmac END
        WHERE document_id = ?
      `).run(row.document_id);
      appendEncryptedAuditLog(options.database, options.crypto, {
        id: idGenerator(),
        actorType: 'system',
        actorId,
        action: 'delete',
        entityType: 'ocr_raw_payload',
        entityId: row.id,
        beforeHash: null,
        afterHash: null,
        detail: { kind: 'operation', operation: 'delete', outcome: 'ok' },
        requestId,
        createdAt: purgedAt,
      });
      return true;
    })();
    if (changed) result.purged += 1;
  }
  return result;
}

