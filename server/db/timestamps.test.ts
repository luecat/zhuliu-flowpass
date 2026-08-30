import { describe, expect, it } from 'vitest';
import { parseUtcRfc3339Timestamp } from './timestamps';

describe('parseUtcRfc3339Timestamp', () => {
  it('canonicalizes an explicit RFC3339 offset to UTC', () => {
    expect(parseUtcRfc3339Timestamp('2026-08-30T08:00:00+08:00', 'availableAt')).toBe(
      '2026-08-30T00:00:00.000Z',
    );
  });

  it.each([
    '2026-08-30',
    '2026-08-30 00:00:00',
    '2026-08-30T00:00:00',
    '2026-08-30T00:00:00+0800',
    '2026-08-30T00:00:00+24:00',
    '2026-02-30T00:00:00Z',
  ])('rejects a non-canonical or invalid RFC3339 timestamp: %s', (value) => {
    expect(() => parseUtcRfc3339Timestamp(value, 'availableAt')).toThrow('availableAt must be');
  });
});
