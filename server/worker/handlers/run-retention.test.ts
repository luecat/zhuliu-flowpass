import { describe, expect, it } from 'vitest';
import { runRetentionJob } from './run-retention';

describe('retention worker', () => {
  it('rejects jobs from another queue class', async () => {
    await expect(runRetentionJob({ id: 'j', jobType: 'ocr', payload: {}, state: 'leased', uniqueKey: 'u', attempts: 1, maxAttempts: 1, availableAt: '', leaseOwner: 'w', leaseUntil: null, lastErrorCode: null, createdAt: '', completedAt: null }, { workerId: 'w' }, { database: {} as never, crypto: {} as never })).rejects.toThrow('unsupported retention job');
  });
});

