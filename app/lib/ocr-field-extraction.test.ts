import { describe, expect, it } from 'vitest';
import {
  extractCardTransactionCandidates,
  extractDate,
  extractInvoiceNumber,
  extractOriginalAmount,
  extractReceiptBuyerName,
  extractVendorReceiptCandidates,
  type OcrLine,
} from './ocr-field-extraction';

function line(text: string, confidence = 1): OcrLine {
  return { text, confidence, box: { x: 0, y: 0, width: 1, height: 1 } };
}

describe('extractDate', () => {
  it('reads an ISO date embedded in a longer line', () => {
    expect(extractDate([line('$20.00 paid on 2026-06-11')])).toBe('2026-06-11');
  });
  it('reads a named-month date', () => {
    expect(extractDate([line('Date paid'), line('June 11, 2026')])).toBe('2026-06-11');
  });
});

describe('extractOriginalAmount', () => {
  it('prefers an explicit currency code', () => {
    expect(extractOriginalAmount([line('USD 240.00')])).toEqual({ currency: 'USD', amount: '240.00' });
  });
  it('maps a currency symbol to its code', () => {
    expect(extractOriginalAmount([line('$20.00 paid on June 11, 2026')])).toEqual({ currency: 'USD', amount: '20.00' });
  });
  it('returns null when nothing looks like money', () => {
    expect(extractOriginalAmount([line('Subtotal')])).toBeNull();
  });
});

describe('extractInvoiceNumber', () => {
  it('reads a same-line "invoice number" label before falling back to "receipt number"', () => {
    expect(extractInvoiceNumber([line('Invoice number KS98K7HU-0002'), line('Receipt number 2648-4734-7995')])).toBe('KS98K7HU-0002');
  });
  it('falls back to receipt number when no invoice number is on the same line as its label', () => {
    expect(extractInvoiceNumber([line('Invoice number'), line('KS98K7HU-0003'), line('Receipt number 2392-5288-3820')])).toBe('2392-5288-3820');
  });
  it('never picks up a value wrapped onto a following line, even as a last resort', () => {
    // Regression: a receipt number split across two lines used to be picked
    // up as a truncated value ("2648-4734-" without its "7995" suffix).
    expect(extractInvoiceNumber([line('Receipt number'), line('2648-4734-'), line('7995')])).toBeNull();
  });
});

describe('extractReceiptBuyerName', () => {
  it('reads the line after "Bill to" when confidence is high enough', () => {
    expect(extractReceiptBuyerName([line('Bill to'), line('CHEN PEI-I', 0.5)])).toBe('CHEN PEI-I');
  });
  it('rejects a low-confidence read instead of returning a possibly-garbled name', () => {
    // Regression: real Vision OCR misread "CHEN PEI-I" as "CHEN PEH-" at 0.30
    // confidence — a name-consistency false mismatch is worse than a blank field.
    expect(extractReceiptBuyerName([line('Bill to'), line('CHEN PEH-', 0.3)])).toBeNull();
  });
  it('skips an email or address line instead of the actual name', () => {
    expect(extractReceiptBuyerName([line('Bill to'), line('someone@example.com')])).toBeNull();
  });
});

describe('extractCardTransactionCandidates', () => {
  it('reads the printed TWD amount', () => {
    expect(extractCardTransactionCandidates([line('NT$6,300.00 paid on September 2, 2026')])).toEqual({ convertedTwd: 6300 });
  });
  it('returns null when no TWD amount is present', () => {
    expect(extractCardTransactionCandidates([line('$20.00')])).toEqual({ convertedTwd: null });
  });
});

describe('extractVendorReceiptCandidates', () => {
  it('combines all four fields from a realistic set of lines', () => {
    const result = extractVendorReceiptCandidates([
      line('Invoice number KS98K7HU-0002'),
      line('June 11, 2026'),
      line('Bill to'),
      line('CHEN PEI-I', 0.5),
      line('$20.00 paid on June 11, 2026'),
    ]);
    expect(result).toEqual({
      invoiceNumber: 'KS98K7HU-0002',
      purchaseDate: '2026-06-11',
      originalCurrency: 'USD',
      originalExpense: '20.00',
      receiptBuyerName: 'CHEN PEI-I',
    });
  });
});
