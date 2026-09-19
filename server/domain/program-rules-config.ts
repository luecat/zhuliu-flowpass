import { z } from 'zod';

/**
 * Admin-configurable knobs stored in program_rule_versions.rules_json. The
 * column has existed since the first migration as a free-form blob; this is
 * its first consumer. Unknown or malformed content degrades to "no override"
 * rather than failing submission, since a draft rule version may hold partial
 * or hand-edited JSON.
 */
const ProgramRulesConfigSchema = z.object({
  referenceFxRates: z.record(z.string(), z.number().positive()).optional(),
  ageEligibility: z.object({
    minAge: z.number().int().min(0).max(150).optional(),
    maxAge: z.number().int().min(0).max(150).optional(),
  }).optional(),
  softwareBlacklist: z.array(z.string()).optional(),
});

export type ProgramRulesConfig = z.infer<typeof ProgramRulesConfigSchema>;

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
