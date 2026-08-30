import { z } from 'zod';

export const CORE_ANSWER_LIMITS = {
  material: 500,
  aiPurpose: 500,
  sensitiveData: 600,
  destinationAndAudience: 500,
  total: 2_100,
} as const;

export const CoreAnswersSchema = z.object({
  material: z.string(),
  aiPurpose: z.string(),
  sensitiveData: z.string(),
  destinationAndAudience: z.string(),
}).strict();

export type CoreAnswers = z.infer<typeof CoreAnswersSchema>;

export function unicodeScalarLength(value: string): number {
  return Array.from(value).length;
}

export function validateCoreAnswers(value: unknown): CoreAnswers {
  const parsed = CoreAnswersSchema.parse(value);
  for (const key of ['material', 'aiPurpose', 'sensitiveData', 'destinationAndAudience'] as const) {
    if (!parsed[key].trim()) {
      throw new Error(`${key} must not be blank`);
    }
    if (unicodeScalarLength(parsed[key]) > CORE_ANSWER_LIMITS[key]) {
      throw new Error(`${key} exceeds its Unicode scalar limit`);
    }
  }
  if (unicodeScalarLength(parsed.material) + unicodeScalarLength(parsed.aiPurpose) +
      unicodeScalarLength(parsed.sensitiveData) + unicodeScalarLength(parsed.destinationAndAudience) > CORE_ANSWER_LIMITS.total) {
    throw new Error('answers exceed the combined Unicode scalar limit');
  }
  return parsed;
}

export function serializeCoreAnswers(value: CoreAnswers): string {
  return JSON.stringify({
    material: value.material,
    aiPurpose: value.aiPurpose,
    sensitiveData: value.sensitiveData,
    destinationAndAudience: value.destinationAndAudience,
  });
}
