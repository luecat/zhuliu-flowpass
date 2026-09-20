import { z } from 'zod';

/**
 * Admin-configurable knobs stored in program_rule_versions.rules_json. The
 * column has existed since the first migration as a free-form blob; this is
 * its first consumer. Unknown or malformed content degrades to "no override"
 * rather than failing submission, since a draft rule version may hold partial
 * or hand-edited JSON.
 */

/** Calendar date, not a timestamp: an admin configures 出生日期 as a plain YYYY-MM-DD. */
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, { message: '出生日期需為存在的日期（YYYY-MM-DD）。' });

/**
 * Two independent ways to express the same eligibility, both optional and both
 * enforced when set: minAge/maxAge is evaluated against the submission date and
 * therefore moves with time, while birthDateFrom/birthDateTo pins a fixed birth
 * cohort. A programme that says "民國 95 年至 100 年出生" wants the latter.
 */
const AgeEligibilitySchema = z.object({
  minAge: z.number().int().min(0).max(150).optional(),
  maxAge: z.number().int().min(0).max(150).optional(),
  birthDateFrom: CalendarDateSchema.optional(),
  birthDateTo: CalendarDateSchema.optional(),
});

const ProgramRulesConfigSchema = z.object({
  referenceFxRates: z.record(z.string(), z.number().positive()).optional(),
  ageEligibility: AgeEligibilitySchema.optional(),
  softwareBlacklist: z.array(z.string()).optional(),
});

export type ProgramRulesConfig = z.infer<typeof ProgramRulesConfigSchema>;
export type AgeEligibilityConfig = z.infer<typeof AgeEligibilitySchema>;

export function parseProgramRulesConfig(rulesJson: string): ProgramRulesConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rulesJson);
  } catch {
    return {};
  }
  const result = ProgramRulesConfigSchema.safeParse(parsed);
  return result.success ? result.data : {};
}

/** The admin-editable slice of the config; the rest of rules_json is left alone. */
export interface ProgramRuleSettings {
  softwareBlacklist: string[];
  ageEligibility: AgeEligibilityConfig;
}

const ProgramRuleSettingsInputSchema = z.object({
  softwareBlacklist: z.array(z.string()).max(500).optional(),
  ageEligibility: AgeEligibilitySchema.nullish(),
});

export type ProgramRuleSettingsError =
  | 'invalid_shape'
  | 'age_range_inverted'
  | 'birth_date_range_inverted'
  | 'blacklist_entry_too_long';

/**
 * Strict counterpart to {@link parseProgramRulesConfig}: an admin save is
 * rejected outright rather than silently degraded, so a typo cannot quietly
 * disable a denylist the reviewer believes is in force.
 */
export function normalizeProgramRuleSettings(
  input: unknown,
): { ok: true; settings: ProgramRuleSettings } | { ok: false; reason: ProgramRuleSettingsError } {
  const parsed = ProgramRuleSettingsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid_shape' };

  const entries = parsed.data.softwareBlacklist ?? [];
  if (entries.some((entry) => entry.normalize('NFKC').trim().length > 200)) {
    return { ok: false, reason: 'blacklist_entry_too_long' };
  }
  // Trimmed, blank-free and case-insensitively deduplicated: the stored list is
  // what a reviewer reads back, and toolLabelsMatch already ignores case.
  const seen = new Set<string>();
  const softwareBlacklist: string[] = [];
  for (const entry of entries) {
    const value = entry.normalize('NFKC').trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    softwareBlacklist.push(value);
  }

  const age = parsed.data.ageEligibility ?? {};
  if (age.minAge !== undefined && age.maxAge !== undefined && age.minAge > age.maxAge) {
    return { ok: false, reason: 'age_range_inverted' };
  }
  if (age.birthDateFrom && age.birthDateTo && age.birthDateFrom > age.birthDateTo) {
    return { ok: false, reason: 'birth_date_range_inverted' };
  }

  return { ok: true, settings: { softwareBlacklist, ageEligibility: age } };
}

/** Reads the admin-editable slice back out of a stored rules_json blob. */
export function readProgramRuleSettings(rulesJson: string): ProgramRuleSettings {
  const config = parseProgramRulesConfig(rulesJson);
  return { softwareBlacklist: config.softwareBlacklist ?? [], ageEligibility: config.ageEligibility ?? {} };
}

/**
 * Writes the settings back into the source blob, preserving keys this screen
 * does not own (referenceFxRates, and anything a future rule adds). An empty
 * list or empty range is removed rather than stored, so "not configured" reads
 * the same whether a programme never set it or an admin cleared it.
 */
export function applyProgramRuleSettings(rulesJson: string, settings: ProgramRuleSettings): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rulesJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = { ...parsed as Record<string, unknown> };
  } catch {
    base = {};
  }
  if (settings.softwareBlacklist.length) base.softwareBlacklist = settings.softwareBlacklist;
  else delete base.softwareBlacklist;
  if (Object.keys(settings.ageEligibility).length) base.ageEligibility = settings.ageEligibility;
  else delete base.ageEligibility;
  return JSON.stringify(base);
}
