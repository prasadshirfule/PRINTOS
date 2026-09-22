import { describe, it, expect } from 'vitest';
import { formatCustomerContact } from '@/lib/utils/phone-formatter';

describe('Customer Contact Privacy & Masking Utility', () => {
  it('masks standard 10-digit Indian phone number', () => {
    const raw = '8080750206';
    const formatted = formatCustomerContact(raw);

    expect(formatted).toBe('80••••0206');
    expect(formatted).not.toContain(raw);
    expect(formatted).not.toContain('75');
  });

  it('masks 12-digit Indian phone number with 91 country code', () => {
    const raw = '918080750206';
    const formatted = formatCustomerContact(raw);

    expect(formatted).toBe('+91 80••••0206');
    expect(formatted).not.toContain(raw);
  });

  it('masks Indian phone number with explicit leading +91', () => {
    const raw = '+918080750206';
    const formatted = formatCustomerContact(raw);

    expect(formatted).toBe('+91 80••••0206');
    expect(formatted).not.toContain('8080750206');
  });

  it('masks WhatsApp @c.us JID without exposing full phone number', () => {
    const raw = '918080750206@c.us';
    const formatted = formatCustomerContact(raw);

    expect(formatted).toBe('+91 80••••0206');
    expect(formatted).not.toContain('8080750206');
  });

  it('preserves WhatsApp LID without treating it as a normal phone number', () => {
    const lid = '20495684599884@lid';
    const formatted = formatCustomerContact(lid);

    expect(formatted).toBe('WhatsApp LID: 20495684599884@lid');
    expect(formatted).not.toContain('+91');
    expect(formatted).toContain('@lid');
  });

  it('handles null, undefined, and empty string gracefully', () => {
    expect(formatCustomerContact(null)).toBe('—');
    expect(formatCustomerContact(undefined)).toBe('—');
    expect(formatCustomerContact('')).toBe('—');
    expect(formatCustomerContact('   ')).toBe('—');
  });

  it('masks international numbers while preserving country code', () => {
    const usRaw = '+14155552671';
    const formatted = formatCustomerContact(usRaw);

    expect(formatted).toBe('+1 41••••2671');
    expect(formatted).not.toContain('555');
    expect(formatted).not.toContain('4155552671');
  });

  it('safely masks short or irregular numerical contacts', () => {
    expect(formatCustomerContact('12345')).toBe('1••••45');
    expect(formatCustomerContact('99')).toBe('••••');
  });
});
