import { describe, expect, it } from 'vitest';
import {
  DATA_CATEGORY_VALUES,
  FlowPassPassportSchema,
  NODE_KIND_GUIDE,
  PASSPORT_JSON_SCHEMA,
} from './passport-contract';

describe('shared passport contract', () => {
  it('keeps constrained JSON and Zod centered on canonical follow-up questions', () => {
    const draft = PASSPORT_JSON_SCHEMA.properties.passport_draft;

    expect(draft.required).toContain('follow_up_questions');
    expect(draft.required).not.toContain('confirmation_questions');
    expect(draft.properties.follow_up_questions.maxItems).toBe(12);
    expect(FlowPassPassportSchema.safeParse({}).success).toBe(false);
  });

  it('labels data categories as categories rather than node kinds', () => {
    expect(DATA_CATEGORY_VALUES).toContain('creative_asset');
    expect(NODE_KIND_GUIDE.allowed_values).not.toContain('creative_asset');
  });

  it('documents that byte budgets are enforced by the canonical runtime validator', () => {
    expect(PASSPORT_JSON_SCHEMA.$comment).toContain('UTF-8');
    expect(PASSPORT_JSON_SCHEMA['x-flowpass-runtime-limits']).toMatchObject({
      string_utf8_bytes_max: 4 * 1024,
      document_utf8_bytes_max: 256 * 1024,
      enforcement: 'canonical runtime validator',
    });
  });
});
