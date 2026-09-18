import { describe, it, expect } from 'vitest';
import { calculatePrintOrderPrice, PricingValidationError } from '@/lib/pricing/pricing-engine';

describe('Pricing Engine (Deterministic Minor-Currency Units)', () => {
  it('calculates A4 B&W one-sided print: 12 pages, 1 copy = ₹24.00 (2400 paisa)', () => {
    const res = calculatePrintOrderPrice({
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      totalDocumentPages: 12,
    });

    expect(res.printablePages).toBe(12);
    expect(res.copies).toBe(1);
    expect(res.ratePerPagePaisa).toBe(200);
    expect(res.totalAmountPaisa).toBe(2400);
    expect(res.totalAmountFormatted).toBe('₹24.00');
  });

  it('calculates A4 B&W duplex: 12 pages, 2 copies = ₹48.00 (4800 paisa)', () => {
    const res = calculatePrintOrderPrice({
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'BOTH_SIDES',
      copies: 2,
      totalDocumentPages: 12,
    });

    expect(res.printablePages).toBe(12);
    expect(res.copies).toBe(2);
    expect(res.subtotalPaisa).toBe(4800);
    expect(res.totalAmountPaisa).toBe(4800);
  });

  it('calculates A4 Colour: 5 pages, 1 copy = ₹50.00 (5000 paisa)', () => {
    const res = calculatePrintOrderPrice({
      paperSize: 'A4',
      colorMode: 'COLOR',
      printSides: 'ONE_SIDED',
      copies: 1,
      totalDocumentPages: 5,
    });

    expect(res.ratePerPagePaisa).toBe(1000);
    expect(res.totalAmountPaisa).toBe(5000);
    expect(res.totalAmountFormatted).toBe('₹50.00');
  });

  it('calculates A5 B&W: 10 pages, 1 copy = ₹10.00 (1000 paisa)', () => {
    const res = calculatePrintOrderPrice({
      paperSize: 'A5',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      totalDocumentPages: 10,
    });

    expect(res.ratePerPagePaisa).toBe(100);
    expect(res.totalAmountPaisa).toBe(1000);
  });

  it('calculates A5 Colour: 4 pages, 2 copies = ₹40.00 (4000 paisa)', () => {
    const res = calculatePrintOrderPrice({
      paperSize: 'A5',
      colorMode: 'COLOR',
      printSides: 'ONE_SIDED',
      copies: 2,
      totalDocumentPages: 4,
    });

    expect(res.ratePerPagePaisa).toBe(500);
    expect(res.totalAmountPaisa).toBe(4000);
  });

  it('calculates custom page selection "1-3, 5" on a 12-page doc: 4 pages * 1 copy = ₹8.00 (800 paisa)', () => {
    const res = calculatePrintOrderPrice({
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      totalDocumentPages: 12,
      pageSelection: '1-3, 5',
    });

    expect(res.printablePages).toBe(4);
    expect(res.totalAmountPaisa).toBe(800);
    expect(res.totalAmountFormatted).toBe('₹8.00');
  });

  it('applies discount correctly in integer paisa', () => {
    const res = calculatePrintOrderPrice({
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      totalDocumentPages: 10,
      discountPaisa: 500, // ₹5.00 off
    });

    expect(res.subtotalPaisa).toBe(2000);
    expect(res.discountPaisa).toBe(500);
    expect(res.totalAmountPaisa).toBe(1500);
  });

  it('rejects 0 copies', () => {
    expect(() =>
      calculatePrintOrderPrice({
        paperSize: 'A4',
        colorMode: 'BW',
        printSides: 'ONE_SIDED',
        copies: 0,
        totalDocumentPages: 5,
      })
    ).toThrowError(PricingValidationError);
  });

  it('rejects negative copies', () => {
    expect(() =>
      calculatePrintOrderPrice({
        paperSize: 'A4',
        colorMode: 'BW',
        printSides: 'ONE_SIDED',
        copies: -2,
        totalDocumentPages: 5,
      })
    ).toThrowError(PricingValidationError);
  });

  it('rejects copies exceeding maximum limit (51 > 50)', () => {
    expect(() =>
      calculatePrintOrderPrice({
        paperSize: 'A4',
        colorMode: 'BW',
        printSides: 'ONE_SIDED',
        copies: 51,
        totalDocumentPages: 5,
      })
    ).toThrowError(PricingValidationError);
  });
});
