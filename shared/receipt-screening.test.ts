import { describe, expect, it } from 'vitest';
import { findBlockedReceiptTerm } from './receipt-screening';
import { DEFAULT_BLOCKED_VENDORS } from './default-blocked-vendors';
import type { OcrLineContract } from './ocr-contract';

function line(text: string, confidence = 1): OcrLineContract {
  return { text, confidence, box: { x: 0, y: 0, width: 1, height: 1 } };
}

describe('findBlockedReceiptTerm', () => {
  it('catches a relay product name printed in the line items, not just in a vendor field', () => {
    expect(findBlockedReceiptTerm([
      line('電子發票開立資訊'),
      line('品名 Token Plan Individual'),
      line('金額 12.63'),
    ], DEFAULT_BLOCKED_VENDORS)).toMatchObject({ term: 'token plan', matched: 'Token Plan' });
  });

  it('catches a blocked vendor sitting in a header no field extractor reads', () => {
    expect(findBlockedReceiptTerm([line('42527414 Alibaba Cloud (Singapore) Private Limited')], DEFAULT_BLOCKED_VENDORS))
      .toMatchObject({ term: 'alibaba' });
  });

  it('ignores a low-confidence line rather than disqualifying on garbled text', () => {
    expect(findBlockedReceiptTerm([line('Alibaba Cloud', 0.2)], DEFAULT_BLOCKED_VENDORS)).toBeNull();
  });

  it('passes an ordinary western receipt through', () => {
    expect(findBlockedReceiptTerm([line('OpenAI, LLC'), line('ChatGPT Plus'), line('USD 20.00')], DEFAULT_BLOCKED_VENDORS)).toBeNull();
  });

  it('is governed by the list it is handed, not by anything built into the code', () => {
    const receipt = [line('42527414 Alibaba Cloud (Singapore) Private Limited')];
    expect(findBlockedReceiptTerm(receipt, [])).toBeNull();
    expect(findBlockedReceiptTerm(receipt, ['alibaba cloud'])).toMatchObject({ term: 'alibaba cloud' });
  });

  it('blocks a vendor receipt that names credit, including a one-time credit purchase', () => {
    expect(findBlockedReceiptTerm([line('API Credit Pack'), line('USD 10.00')], DEFAULT_BLOCKED_VENDORS))
      .toMatchObject({ term: 'credit' });
    expect(findBlockedReceiptTerm([line('Prepaid Credits'), line('GPT Credits 100')], DEFAULT_BLOCKED_VENDORS))
      .toMatchObject({ term: 'credits' });
    expect(findBlockedReceiptTerm([
      line('Anthropic, PBC'),
      line('One-time credit purchase'),
      line('$5.00'),
    ], DEFAULT_BLOCKED_VENDORS)).toMatchObject({ term: 'credit' });
    expect(findBlockedReceiptTerm([line('accreditation certificate')], DEFAULT_BLOCKED_VENDORS)).toBeNull();
  });
});
