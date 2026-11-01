/** Only same-origin relative paths may be used after sign-in (no open redirect). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.length > 2000) return '/';
  if (value.startsWith('/auth/') || value.startsWith('/bff/')) return '/';
  return value;
}
