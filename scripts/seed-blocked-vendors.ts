import { v7 as uuidv7 } from 'uuid';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { openDatabase } from '../server/db/connection';
import { runtimeConfig } from '../server/config/runtime-config';
import {
  createDraftProgramRuleVersionForAdmin,
  listProgramCyclesForAdmin,
  listProgramRuleVersionsForAdmin,
  publishProgramRuleVersionForAdmin,
} from '../server/db/repositories/programs';
import { applyProgramRuleSettings, readProgramRuleSettings } from '../server/domain/program-rules-config';
import { DEFAULT_BLOCKED_VENDORS } from '../shared/default-blocked-vendors';
import type { FlowPassDatabase } from '../server/db/connection';

/**
 * Writes the shipped denylist seed into a program cycle's own softwareBlacklist,
 * so the stored list — the one the admin settings screen shows and edits — is
 * what governs screening, rather than a fallback inside the code.
 *
 * Published rule versions are immutable, so this creates a new version from the
 * current published one and publishes it, exactly as the settings screen does.
 * Existing cases keep the rule version they pinned; the new list applies to
 * cases created from now on.
 *
 * Entries already on the list are kept and not duplicated, so re-running this
 * after an admin has edited the list adds only what is missing.
 */
export function seedBlockedVendors(input: {
  database: FlowPassDatabase;
  adminId: string;
  programCycleId: string;
  now?: string;
  terms?: readonly string[];
}): { ruleVersionId: string; versionNo: number; added: string[]; total: number } {
  const scope = { adminId: input.adminId };
  const now = input.now ?? new Date().toISOString();
  const published = listProgramRuleVersionsForAdmin(input.database, scope, input.programCycleId)
    .find((rule) => rule.status === 'published');
  if (!published) throw new Error(`no published rule version for cycle ${input.programCycleId}`);

  const current = readProgramRuleSettings(published.rulesJson);
  const seen = new Set(current.softwareBlacklist.map((entry) => entry.normalize('NFKC').trim().toLocaleLowerCase()));
  const added: string[] = [];
  for (const term of input.terms ?? DEFAULT_BLOCKED_VENDORS) {
    const value = term.normalize('NFKC').trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    added.push(value);
  }
  const softwareBlacklist = [...current.softwareBlacklist, ...added];

  const result = input.database.transaction(() => {
    const draft = createDraftProgramRuleVersionForAdmin(input.database, scope, {
      sourceRuleVersionId: published.id,
      id: uuidv7(),
      createdAt: now,
      rulesJson: applyProgramRuleSettings(published.rulesJson, { ...current, softwareBlacklist }),
    });
    return publishProgramRuleVersionForAdmin(input.database, scope, { ruleVersionId: draft.id, adminId: input.adminId, publishedAt: now });
  })();

  return { ruleVersionId: result.id, versionNo: result.versionNo, added, total: softwareBlacklist.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const database = openDatabase(join(runtimeConfig.dataRoot, 'data', 'flowpass.sqlite3'));
  try {
    const admin = database.prepare("SELECT id FROM admin_users WHERE status = 'active' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
    if (!admin) throw new Error('no active admin to attribute the rule version to');
    const scope = { adminId: admin.id };
    const cycles = listProgramCyclesForAdmin(database, scope).filter((cycle) => cycle.status === 'active');
    if (cycles.length === 0) throw new Error('no active program cycle');
    for (const cycle of cycles) {
      const result = seedBlockedVendors({ database, adminId: admin.id, programCycleId: cycle.id });
      console.log(JSON.stringify({ cycle: cycle.code, ...result, added: result.added.length }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'seeding failed');
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
