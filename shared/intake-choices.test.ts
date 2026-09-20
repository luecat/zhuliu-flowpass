import { describe, expect, it } from 'vitest';
import {
  isSensitiveNone,
  sensitiveChoiceFromStored,
  sensitiveDataNeedsFollowUp,
} from './intake-choices';

describe('intake choices', () => {
  it('maps stored sensitive answers back to the three stage-1 choices', () => {
    expect(sensitiveChoiceFromStored('無')).toBe('無');
    expect(sensitiveChoiceFromStored('不確定')).toBe('不確定');
    expect(sensitiveChoiceFromStored('人臉、姓名')).toBe('有');
    expect(sensitiveChoiceFromStored('')).toBe('');
  });

  it('only keeps sensitive follow-ups for 有 and 不確定', () => {
    expect(isSensitiveNone('無')).toBe(true);
    expect(sensitiveDataNeedsFollowUp('無')).toBe(false);
    expect(sensitiveDataNeedsFollowUp('不確定')).toBe(true);
    expect(sensitiveDataNeedsFollowUp('人臉')).toBe(true);
  });
});
