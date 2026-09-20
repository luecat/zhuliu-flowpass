import { parseProgramRulesConfig } from './program-rules-config';
import { DEFAULT_BLOCKED_RESELLER_TERMS, DEFAULT_BLOCKED_VENDORS } from '../../shared/default-blocked-vendors';
import type { FlowPassDatabase } from '../db/connection';

function uniqueTerms(...lists: Array<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const term of list) {
      const key = term.normalize('NFKC').trim().toLocaleLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

/**
 * The denylist that governs one case: the softwareBlacklist stored on the rule
 * version the case pinned, plus the shipped reseller vocabulary (token plans,
 * credit packs, 代充). Region vendors stay on the stored list so an admin can
 * still omit them; relay terms are a floor because they date faster than a
 * pinned rule version.
 *
 * A cycle that has never had a list configured falls back to the shipped seed
 * (shared/default-blocked-vendors.ts).
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
  if (configured.length === 0) return DEFAULT_BLOCKED_VENDORS;
  return uniqueTerms(configured, DEFAULT_BLOCKED_RESELLER_TERMS);
}
