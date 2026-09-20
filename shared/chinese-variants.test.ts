import { describe, expect, it } from 'vitest';
import { CHINESE_VARIANT_PAIRS, foldChineseVariants } from './chinese-variants';

describe('foldChineseVariants', () => {
  it('folds traditional vendor names onto their simplified spelling', () => {
    expect(foldChineseVariants('騰訊混元')).toBe('腾讯混元');
    expect(foldChineseVariants('通義千問')).toBe('通义千问');
    expect(foldChineseVariants('API 中轉站')).toBe('API 中转站');
  });

  it('leaves simplified, latin and unlisted characters untouched', () => {
    expect(foldChineseVariants('腾讯混元')).toBe('腾讯混元');
    expect(foldChineseVariants('Alibaba Cloud')).toBe('Alibaba Cloud');
    expect(foldChineseVariants('台北')).toBe('台北');
  });

  it('keeps the string length, so a match index still points into the original', () => {
    const source = '發票開立：騰訊科技股份有限公司';
    expect(foldChineseVariants(source)).toHaveLength(source.length);
  });

  it('has a well-formed table with no duplicate source characters', () => {
    const pairs = CHINESE_VARIANT_PAIRS.trim().split(/\s+/);
    expect(pairs.every((pair) => [...pair].length === 2)).toBe(true);
    expect(new Set(pairs.map((pair) => pair[0])).size).toBe(pairs.length);
  });
});
