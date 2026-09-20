import { z } from 'zod';
import { isSensitiveNone, isSensitiveUncertain } from './intake-choices';

export const CORE_ANSWER_LIMITS = {
  material: 500,
  aiPurpose: 500,
  sensitiveData: 600,
  destinationAndAudience: 500,
  requestedTool: 100,
  retentionDuration: 100,
  applicantName: 100,
  total: 2_400,
} as const;

const STAGE1_KEYS = [
  'material',
  'aiPurpose',
  'sensitiveData',
  'destinationAndAudience',
  'requestedTool',
  'retentionDuration',
] as const;

/** Accepts legacy rows that predate newer stage-1 fields and incomplete wizard drafts. */
export const CoreAnswersSchema = z.object({
  material: z.string().default(''),
  aiPurpose: z.string().default(''),
  sensitiveData: z.string().default(''),
  destinationAndAudience: z.string().default(''),
  requestedTool: z.string().default(''),
  retentionDuration: z.string().default(''),
  applicantName: z.string().default(''),
});

export type CoreAnswers = z.infer<typeof CoreAnswersSchema>;

export function unicodeScalarLength(value: string): number {
  return Array.from(value).length;
}

function assertSensitiveData(value: string, { allowBlank }: { allowBlank: boolean }): void {
  const text = value.normalize('NFKC').trim();
  if (!text) {
    if (!allowBlank) throw new Error('sensitiveData must not be blank');
    return;
  }
  if (text === '有') throw new Error('sensitiveData detail is required when 有 is selected');
  if (isSensitiveNone(text) || isSensitiveUncertain(text)) return;
  if (unicodeScalarLength(text) > CORE_ANSWER_LIMITS.sensitiveData) {
    throw new Error('sensitiveData exceeds its Unicode scalar limit');
  }
}

function assertAnswerLimits(parsed: CoreAnswers, { allowBlank }: { allowBlank: boolean }): CoreAnswers {
  let filled = 0;
  // Stage-1 wizard fields only. applicantName is collected in purchase details.
  for (const key of STAGE1_KEYS) {
    const value = parsed[key];
    if (key === 'sensitiveData') {
      assertSensitiveData(value, { allowBlank });
      if (value.trim()) filled += 1;
      continue;
    }
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
  const total = STAGE1_KEYS.reduce((sum, key) => sum + unicodeScalarLength(parsed[key]), 0);
  if (total > CORE_ANSWER_LIMITS.total) {
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
    requestedTool: value.requestedTool,
    retentionDuration: value.retentionDuration,
    applicantName: value.applicantName,
  });
}
