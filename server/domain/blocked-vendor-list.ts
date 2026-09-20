import { parseProgramRulesConfig } from './program-rules-config';
import { DEFAULT_BLOCKED_VENDORS } from '../../shared/default-blocked-vendors';
import type { FlowPassDatabase } from '../db/connection';

/**
 * The denylist that governs one case: the softwareBlacklist stored on the rule
 * version the case pinned. That stored list is the authority — screening is a
 * list lookup an admin can read and edit, not a judgement built into code.
 *
 * A cycle that has never had a list configured falls back to the shipped seed
 * (shared/default-blocked-vendors.ts) so a new program is not wide open before
 * anyone visits the settings screen. Seeding the cycle replaces that fallback
 * with a list the admin can see.
 */
export function blockedTermsForCase(database: FlowPassDatabase, caseId: string): readonly string[] {
  const row = database.prepare(`
    SELECT program_rule_versions.rules_json AS rules_json
    FROM cases
    JOIN program_rule_versions ON program_rule_versions.id = cases.program_rule_version_id
    WHERE cases.id = ? AND cases.deleted_at IS NULL
  `).get(caseId) as { rules_json: string } | undefined;
  if (!row) return DEFAULT_BLOCKED_VENDORS;
  const configured = parseProgramRulesConfig(row.rules_json).softwareBlacklist ?? [];
  return configured.length > 0 ? configured : DEFAULT_BLOCKED_VENDORS;
}
