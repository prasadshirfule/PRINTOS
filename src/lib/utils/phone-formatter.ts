/**
 * Customer Contact Phone Formatter & Privacy Masking Utility
 * Masks customer phone numbers for presentation across admin interfaces while preserving WhatsApp LIDs.
 */

export function formatCustomerContact(phone?: string | null): string {
  if (!phone || typeof phone !== 'string') {
    return '—';
  }

  const trimmed = phone.trim();
  if (!trimmed) {
    return '—';
  }

  // 1. WhatsApp LID check (never treat LID as a normal phone number or strip @lid)
  if (trimmed.toLowerCase().includes('@lid')) {
    return `WhatsApp LID: ${trimmed}`;
  }

  // Strip standard WhatsApp user domain if present (e.g. 918080750206@c.us or @s.whatsapp.net)
  const cleanDomain = trimmed.replace(/@c\.us$/i, '').replace(/@s\.whatsapp\.net$/i, '').trim();

  // Extract raw digits
  const hasPlus = cleanDomain.startsWith('+');
  const digits = cleanDomain.replace(/\D/g, '');

  if (!digits) {
    return '—';
  }

  // 2. Standard 10-digit Indian mobile number (e.g. 8080750206)
  if (digits.length === 10) {
    const first2 = digits.slice(0, 2);
    const last4 = digits.slice(6);
    return `${first2}••••${last4}`;
  }

  // 3. 12-digit Indian mobile number with 91 prefix (e.g. 918080750206 or +918080750206)
  if (digits.length === 12 && digits.startsWith('91')) {
    const local = digits.slice(2);
    const first2 = local.slice(0, 2);
    const last4 = local.slice(6);
    return `+91 ${first2}••••${last4}`;
  }

  // 4. Other international numbers (e.g. +14155552671 or 14155552671)
  if (digits.length >= 7) {
    // If it had a leading plus, or is > 10 digits
    if (hasPlus || digits.length > 10) {
      // Guess country code length (1 digit for US/CA, 2 digits for most others)
      const ccLength = digits.startsWith('1') ? 1 : 2;
      const cc = digits.slice(0, ccLength);
      const rest = digits.slice(ccLength);
      const first2 = rest.slice(0, 2);
      const last4 = rest.slice(-4);
      return `+${cc} ${first2}••••${last4}`;
    }

    const first2 = digits.slice(0, 2);
    const last4 = digits.slice(-4);
    return `${first2}••••${last4}`;
  }

  // 5. Short or irregular numbers -> safe fallback mask
  if (digits.length >= 4) {
    return `${digits.slice(0, 1)}••••${digits.slice(-2)}`;
  }

  return '••••';
}
