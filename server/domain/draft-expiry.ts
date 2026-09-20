import type { FlowPassDatabase } from '../db/connection';

/** Soft-delete applicant drafts that have been idle longer than this. */
export const DRAFT_IDLE_TTL_MS = 30 * 60_000;

export function draftIdleCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - DRAFT_IDLE_TTL_MS).toISOString();
}

/**
 * Soft-deletes `draft` cases whose `updated_at` is older than the idle TTL.
 * Active editing bumps `updated_at`, so in-progress drafts are kept.
 */
export function expireStaleDrafts(
  database: FlowPassDatabase,
  now: Date = new Date(),
): { expiredCount: number; cutoffAt: string; expiredAt: string } {
  const cutoffAt = draftIdleCutoffIso(now);
  const expiredAt = now.toISOString();
  const result = database.prepare(`
    UPDATE cases
    SET deleted_at = ?, updated_at = ?, row_version = row_version + 1
    WHERE state = 'draft'
      AND deleted_at IS NULL
      AND updated_at < ?
  `).run(expiredAt, expiredAt, cutoffAt);
  return { expiredCount: result.changes, cutoffAt, expiredAt };
}

/** If this case is an idle draft past the TTL, soft-delete it and return true. */
export function expireDraftCaseIfStale(
  database: FlowPassDatabase,
  caseId: string,
  now: Date = new Date(),
): boolean {
  const cutoffAt = draftIdleCutoffIso(now);
  const expiredAt = now.toISOString();
  const result = database.prepare(`
    UPDATE cases
    SET deleted_at = ?, updated_at = ?, row_version = row_version + 1
    WHERE id = ?
      AND state = 'draft'
      AND deleted_at IS NULL
      AND updated_at < ?
  `).run(expiredAt, expiredAt, caseId, cutoffAt);
  return result.changes > 0;
}

/**
 * Soft-deletes a draft that screening has disqualified, in the same way an
 * idle draft is cleared: the case is marked deleted, so the applicant starts a
 * new application instead of resubmitting the rejected one.
 *
 * Only a draft is touched. A case that has already been submitted belongs to a
 * reviewer, and nothing here may remove it.
 */
export function deleteBlockedDraftCase(
  database: FlowPassDatabase,
  input: { caseId: string; applicantId: string; now?: Date },
): boolean {
  const deletedAt = (input.now ?? new Date()).toISOString();
  const result = database.prepare(`
    UPDATE cases
    SET deleted_at = ?, updated_at = ?, row_version = row_version + 1
    WHERE id = ?
      AND applicant_id = ?
      AND state = 'draft'
      AND deleted_at IS NULL
  `).run(deletedAt, deletedAt, input.caseId, input.applicantId);
  return result.changes > 0;
}
