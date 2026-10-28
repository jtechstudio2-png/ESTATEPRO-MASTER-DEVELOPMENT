import type { UiLanguage } from '@/lib/session-types';

/** Message namespaces, one JSON file per language each (W-D5: message files from day one). */
export const NAMESPACES = [
  'common',
  'nav',
  'search',
  'list',
  'errors',
  'form',
  'auth',
  'dashboard',
  'keys',
] as const;

export async function loadMessages(language: UiLanguage): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const module = (await import(`./${language}/${namespace}.json`)) as { default: Record<string, unknown> };
      return [namespace, module.default] as const;
    }),
  );
  return Object.fromEntries(entries);
}
