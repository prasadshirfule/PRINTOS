import { describe, it, expect } from 'vitest';
import { parsePageRange, InvalidPageRangeError } from '@/lib/pricing/page-range';

describe('Page Range Parser & Validator', () => {
  it('parses valid range "1-5" on a 10-page document', () => {
    const res = parsePageRange('1-5', 10);
    expect(res.count).toBe(5);
    expect(res.pages).toEqual([1, 2, 3, 4, 5]);
    expect(res.normalizedString).toBe('1-5');
  });

  it('parses complex selection "1-3, 5, 7-10" on a 12-page document', () => {
    const res = parsePageRange('1-3, 5, 7-10', 12);
    expect(res.count).toBe(8);
    expect(res.pages).toEqual([1, 2, 3, 5, 7, 8, 9, 10]);
  });

  it('handles whitespace gracefully "  1 - 3 ,  5 , 7-9  "', () => {
    const res = parsePageRange('  1 - 3 ,  5 , 7-9  ', 10);
    expect(res.count).toBe(7);
    expect(res.pages).toEqual([1, 2, 3, 5, 7, 8, 9]);
  });

  it('normalizes duplicate pages "1, 2, 2, 3, 3, 3" into unique sorted list', () => {
    const res = parsePageRange('1, 2, 2, 3, 3, 3', 5);
    expect(res.count).toBe(3);
    expect(res.pages).toEqual([1, 2, 3]);
  });

  it('defaults to all document pages when input is empty, null, or "all"', () => {
    expect(parsePageRange(null, 5).count).toBe(5);
    expect(parsePageRange(undefined, 8).count).toBe(8);
    expect(parsePageRange('', 6).count).toBe(6);
    expect(parsePageRange('all', 7).count).toBe(7);
    expect(parsePageRange('ALL', 4).pages).toEqual([1, 2, 3, 4]);
  });

  it('rejects reversed ranges such as "5-1"', () => {
    expect(() => parsePageRange('5-1', 10)).toThrowError(InvalidPageRangeError);
  });

  it('rejects page 0', () => {
    expect(() => parsePageRange('0-5', 10)).toThrowError(InvalidPageRangeError);
    expect(() => parsePageRange('0', 10)).toThrowError(InvalidPageRangeError);
  });

  it('rejects negative numbers', () => {
    expect(() => parsePageRange('-1-5', 10)).toThrowError(InvalidPageRangeError);
    expect(() => parsePageRange('-3', 10)).toThrowError(InvalidPageRangeError);
  });

  it('rejects non-numeric input', () => {
    expect(() => parsePageRange('1-abc', 10)).toThrowError(InvalidPageRangeError);
    expect(() => parsePageRange('hello', 10)).toThrowError(InvalidPageRangeError);
  });

  it('rejects pages beyond document page count', () => {
    expect(() => parsePageRange('1-15', 10)).toThrowError(InvalidPageRangeError);
    expect(() => parsePageRange('12', 10)).toThrowError(InvalidPageRangeError);
  });

  it('rejects malformed syntax like "1,,3"', () => {
    expect(() => parsePageRange('1,,3', 10)).toThrowError(InvalidPageRangeError);
  });
});
