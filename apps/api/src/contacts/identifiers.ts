/**
 * Normalisation of contact identifiers for storage, search and duplicate
 * detection (CRM-02). Phone numbers are stored in E.164 (migration 0005);
 * people type them in local formats, so a national number is completed with
 * the calling code of the contact's office country.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Returns the E.164 form, or null when the value cannot be a phone number. */
export function normalisePhone(value: string, countryCallingCode: string | null): string | null {
  let digits = value.trim().replace(/[\s\-.()/]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith('+')) {
    if (countryCallingCode === null || !/^[0-9]+$/.test(digits)) return null;
    digits = `${countryCallingCode}${digits.replace(/^0/, '')}`;
  }
  return E164.test(digits) ? digits : null;
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim()) && value.trim().length <= 254;
}

/** "+233245554412" → "+23324•••4412": enough to recognise a number in a list, not to call it. */
export function maskPhone(e164: string | null): string | null {
  if (e164 === null) return null;
  if (e164.length <= 8) return `${e164.slice(0, 2)}•••${e164.slice(-2)}`;
  return `${e164.slice(0, 6)}•••${e164.slice(-4)}`;
}

/**
 * Same rules as app.search_normalise (migration 0022): lower case, Arabic
 * diacritics and tatweel removed, spelling variants of alef, ya, ta marbuta
 * and hamza carriers folded.
 */
export function searchNormalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** Method types whose value is a phone number. */
export const PHONE_METHOD_TYPES = new Set(['phone', 'mobile', 'whatsapp']);

/** Normalised form of a contact method value; null when invalid for its type. */
export function normaliseMethod(type: string, value: string, countryCallingCode: string | null): string | null {
  if (type === 'email') return isEmail(value) ? normaliseEmail(value) : null;
  if (PHONE_METHOD_TYPES.has(type) || type === 'fax') return normalisePhone(value, countryCallingCode);
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 500 ? trimmed.toLowerCase() : null;
}
