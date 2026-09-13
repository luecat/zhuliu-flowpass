import { z } from 'zod';

export const CORE_ANSWER_LIMITS = {
  material: 500,
  aiPurpose: 500,
  sensitiveData: 600,
  destinationAndAudience: 500,
  applicantName: 100,
  total: 2_100,
} as const;

/** Accepts legacy rows that predate applicantName and incomplete wizard drafts. */
export const CoreAnswersSchema = z.object({
  material: z.string().default(''),
  aiPurpose: z.string().default(''),
  sensitiveData: z.string().default(''),
  destinationAndAudience: z.string().default(''),
  applicantName: z.string().default(''),
});

export type CoreAnswers = z.infer<typeof CoreAnswersSchema>;

export function unicodeScalarLength(value: string): number {
  return Array.from(value).length;
}

function assertAnswerLimits(parsed: CoreAnswers, { allowBlank }: { allowBlank: boolean }): CoreAnswers {
  let filled = 0;
  // Stage-1 wizard fields only. applicantName is collected in purchase details.
  for (const key of ['material', 'aiPurpose', 'sensitiveData', 'destinationAndAudience'] as const) {
    const value = parsed[key];
    if (!value.trim()) {
      if (!allowBlank) throw new Error(`${key} must not be blank`);
      continue;
    }
    filled += 1;
    if (unicodeScalarLength(value) > CORE_ANSWER_LIMITS[key]) {
      throw new Error(`${key} exceeds its Unicode scalar limit`);
    }
  }
  if (parsed.applicantName.trim() && unicodeScalarLength(parsed.applicantName) > CORE_ANSWER_LIMITS.applicantName) {
    throw new Error('applicantName exceeds its Unicode scalar limit');
  }
  if (allowBlank && filled === 0) {
    throw new Error('at least one answer is required');
  }
  if (unicodeScalarLength(parsed.material) + unicodeScalarLength(parsed.aiPurpose)
    + unicodeScalarLength(parsed.sensitiveData) + unicodeScalarLength(parsed.destinationAndAudience) > CORE_ANSWER_LIMITS.total) {
    throw new Error('answers exceed the combined Unicode scalar limit');
  }
  return parsed;
}

export function parseStoredCoreAnswers(value: unknown): CoreAnswers {
  return CoreAnswersSchema.parse(value);
}

export function validateCoreAnswers(value: unknown): CoreAnswers {
  return assertAnswerLimits(CoreAnswersSchema.parse(value), { allowBlank: false });
}

/** Allows incomplete wizard drafts so each answered question can be persisted. */
export function validateDraftCoreAnswers(value: unknown): CoreAnswers {
  return assertAnswerLimits(CoreAnswersSchema.parse(value), { allowBlank: true });
}

export function serializeCoreAnswers(value: CoreAnswers): string {
  return JSON.stringify({
    material: value.material,
    aiPurpose: value.aiPurpose,
    sensitiveData: value.sensitiveData,
    destinationAndAudience: value.destinationAndAudience,
    applicantName: value.applicantName,
  });
}
