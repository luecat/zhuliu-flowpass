import { describe, expect, it } from 'vitest';
import {
  applyProgramRuleSettings,
  normalizeProgramRuleSettings,
  parseProgramRulesConfig,
  readProgramRuleSettings,
} from './program-rules-config';

describe('normalizeProgramRuleSettings', () => {
  it('trims, drops blanks and deduplicates the blacklist case-insensitively', () => {
    const result = normalizeProgramRuleSettings({ softwareBlacklist: ['  Blocked Vendor ', '', 'blocked vendor', 'Other Co'] });
    expect(result).toEqual({ ok: true, settings: { softwareBlacklist: ['Blocked Vendor', 'Other Co'], ageEligibility: {} } });
  });

  it('accepts a birth-date cohort and an age range together', () => {
    const result = normalizeProgramRuleSettings({ ageEligibility: { minAge: 12, maxAge: 18, birthDateFrom: '2008-01-01', birthDateTo: '2014-12-31' } });
    expect(result).toMatchObject({ ok: true, settings: { ageEligibility: { minAge: 12, maxAge: 18, birthDateFrom: '2008-01-01', birthDateTo: '2014-12-31' } } });
  });

  it('rejects inverted ranges and dates that do not exist', () => {
    expect(normalizeProgramRuleSettings({ ageEligibility: { minAge: 20, maxAge: 12 } })).toEqual({ ok: false, reason: 'age_range_inverted' });
    expect(normalizeProgramRuleSettings({ ageEligibility: { birthDateFrom: '2014-01-01', birthDateTo: '2008-01-01' } })).toEqual({ ok: false, reason: 'birth_date_range_inverted' });
    expect(normalizeProgramRuleSettings({ ageEligibility: { birthDateFrom: '2014-02-30' } })).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(normalizeProgramRuleSettings({ softwareBlacklist: [42] })).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('rejects a blacklist entry long enough to be pasted prose', () => {
    expect(normalizeProgramRuleSettings({ softwareBlacklist: ['x'.repeat(201)] })).toEqual({ ok: false, reason: 'blacklist_entry_too_long' });
  });
});

describe('applyProgramRuleSettings', () => {
  it('preserves keys the settings screen does not own', () => {
    const next = applyProgramRuleSettings(JSON.stringify({ referenceFxRates: { USD: 33 } }), { softwareBlacklist: ['Blocked'], ageEligibility: { birthDateFrom: '2008-01-01' } });
    expect(JSON.parse(next)).toEqual({ referenceFxRates: { USD: 33 }, softwareBlacklist: ['Blocked'], ageEligibility: { birthDateFrom: '2008-01-01' } });
    expect(parseProgramRulesConfig(next).referenceFxRates).toEqual({ USD: 33 });
  });

  it('removes a cleared list or range instead of storing an empty one', () => {
    const next = applyProgramRuleSettings(JSON.stringify({ softwareBlacklist: ['Blocked'], ageEligibility: { minAge: 12 } }), { softwareBlacklist: [], ageEligibility: {} });
    expect(JSON.parse(next)).toEqual({});
    expect(readProgramRuleSettings(next)).toEqual({ softwareBlacklist: [], ageEligibility: {} });
  });

  it('starts from an empty object when the stored blob is unusable', () => {
    expect(JSON.parse(applyProgramRuleSettings('not json', { softwareBlacklist: ['A'], ageEligibility: {} }))).toEqual({ softwareBlacklist: ['A'] });
    expect(JSON.parse(applyProgramRuleSettings('[1,2]', { softwareBlacklist: [], ageEligibility: {} }))).toEqual({});
  });
});
