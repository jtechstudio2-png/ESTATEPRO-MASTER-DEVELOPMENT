import type { FieldError } from '../common/problem.js';
import type { Tx } from '../database/database.module.js';

/**
 * Checks that a code exists in a picklist visible to the company (platform
 * defaults plus the company's own values; RLS hides other companies' values)
 * and applies to the given country.
 */
export async function checkPicklistCode(
  tx: Tx,
  listKey: string,
  code: string,
  countryCode: string,
  field: string,
): Promise<FieldError | null> {
  const found = await tx
    .selectFrom('picklistValues')
    .select('id')
    .where('listKey', '=', listKey)
    .where('code', '=', code)
    .where('isActive', '=', true)
    .where((eb) => eb.or([eb('countryCode', 'is', null), eb('countryCode', '=', countryCode)]))
    .executeTakeFirst();
  return found ? null : { field, code: 'unknown-code', message: `"${code}" is not a valid choice here.` };
}

/** Accept-Language → ordered candidate locales, e.g. "ar-QA,en;q=0.8" → ["ar-QA", "ar", "en"]. */
export function preferredLocales(header: string | undefined): string[] {
  if (!header) return [];
  const weighted = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((item) => /^[A-Za-z]{2,3}(-[A-Za-z]{2})?$/.test(item.tag) && item.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  const result: string[] = [];
  for (const { tag } of weighted) {
    const [language = '', region] = tag.split('-');
    const normalised = region ? `${language.toLowerCase()}-${region.toUpperCase()}` : language.toLowerCase();
    if (!result.includes(normalised)) result.push(normalised);
    if (region && !result.includes(language.toLowerCase())) result.push(language.toLowerCase());
  }
  return result;
}
