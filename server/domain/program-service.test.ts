import { describe, expect, it } from 'vitest';
import { getCurrentProgram, type ProgramServiceDependencies, validateDemoSeedWindows } from './program-service';

describe('program service', () => {
  it('projects only the active published program and separates both windows', () => {
    const deps = {
      listCycles: () => [{ id: 'cycle', code: 'DEMO', name: '示範補助', year: 2026, status: 'active', createdAt: '', updatedAt: '', rowVersion: 1 }],
      listRules: () => [{ id: 'rule', programCycleId: 'cycle', versionNo: 2, status: 'published', applicationStartAt: '2026-09-01T00:00:00.000Z', applicationEndAt: '2026-09-30T00:00:00.000Z', purchaseStartAt: '2026-10-01T00:00:00.000Z', purchaseEndAt: '2026-12-31T00:00:00.000Z', requiredDocumentsJson: '["invoice"]', rulesJson: '{"secret":true}', publishedAt: '2026-08-30T00:00:00.000Z', createdAt: '2026-08-30T00:00:00.000Z', subsidyRateBps: 0, perCaseCapTwd: 0, roundingMode: 'floor' }],
    } satisfies ProgramServiceDependencies;
    const result = getCurrentProgram(deps);
    expect(result).toEqual({
      id: 'cycle', code: 'DEMO', name: '示範補助', year: 2026,
      applicationWindow: { startAt: '2026-09-01T00:00:00.000Z', endAt: '2026-09-30T00:00:00.000Z' },
      eligiblePurchaseWindow: { startAt: '2026-10-01T00:00:00.000Z', endAt: '2026-12-31T00:00:00.000Z' },
      requirements: { requiredDocuments: ['invoice'] },
      rule: { id: 'rule', versionNo: 2, applicationStartAt: '2026-09-01T00:00:00.000Z', applicationEndAt: '2026-09-30T00:00:00.000Z', purchaseStartAt: '2026-10-01T00:00:00.000Z', purchaseEndAt: '2026-12-31T00:00:00.000Z', requiredDocuments: ['invoice'] },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('demo seed windows', () => {
  it('normalizes valid RFC3339 windows and rejects malformed or reversed ranges', () => {
    expect(validateDemoSeedWindows({ applicationStart: '2026-09-01T00:00:00+08:00', applicationEnd: '2026-09-30T00:00:00+08:00', purchaseStart: '2026-10-01T00:00:00+08:00', purchaseEnd: '2026-12-31T00:00:00+08:00' })).toEqual({ applicationStart: '2026-08-31T16:00:00.000Z', applicationEnd: '2026-09-29T16:00:00.000Z', purchaseStart: '2026-09-30T16:00:00.000Z', purchaseEnd: '2026-12-30T16:00:00.000Z' });
    expect(() => validateDemoSeedWindows({ applicationStart: 'bad', applicationEnd: '2026-09-30T00:00:00Z', purchaseStart: '2026-10-01T00:00:00Z', purchaseEnd: '2026-12-31T00:00:00Z' })).toThrow();
    expect(() => validateDemoSeedWindows({ applicationStart: '2026-09-30T00:00:00Z', applicationEnd: '2026-09-01T00:00:00Z', purchaseStart: '2026-10-01T00:00:00Z', purchaseEnd: '2026-12-31T00:00:00Z' })).toThrow();
  });
});
