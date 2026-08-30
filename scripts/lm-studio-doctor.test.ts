import { describe, expect, it } from 'vitest';
import { loadAiFixtures, runFixtureBenchmark } from './lm-studio-doctor';
import { FLOWPASS_SAMPLE } from '../app/passport-sample';

describe('LM Studio doctor fixture harness', () => {
  it('loads all de-identified fixtures and the maximum legal case without network access', async () => {
    const fixtures = loadAiFixtures();
    expect(fixtures).toHaveLength(20);
    const results = await runFixtureBenchmark({ complete: async () => ({ content: JSON.stringify(FLOWPASS_SAMPLE), model: 'fixture', inputTokens: 1, outputTokens: 1 }) }, fixtures);
    expect(results).toHaveLength(21);
    expect(results.every((result) => result.valid)).toBe(true);
  });
});

