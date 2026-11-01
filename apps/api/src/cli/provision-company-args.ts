import { parseArgs } from 'node:util';

import type { ProvisionCompanyInput } from '../provisioning/provisioning.service.js';

export const USAGE = `Usage: provision-company --staff-email <email> --legal-name <name> --slug <slug>
  --country <ISO2> --data-region <region> --office-code <CODE> --office-name <name>
  --owner-email <email> --owner-name <name>
  [--trading-name <name>] [--jurisdiction <code>] [--currency <ISO3>] [--locale <code>]
  [--timezone <IANA>] [--business-types agency,property_manager,...] [--status trial|active]
  [--trial-days <n>] [--plan starter|professional|enterprise]

Requires PLATFORM_DATABASE_URL (a connection as the estatepro_platform role).`;

/** Turns command-line flags into provisioning input; validation happens in the service. */
export function parseProvisionArgs(argv: string[]): ProvisionCompanyInput {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'staff-email': { type: 'string' },
      'legal-name': { type: 'string' },
      'trading-name': { type: 'string' },
      slug: { type: 'string' },
      country: { type: 'string' },
      jurisdiction: { type: 'string' },
      currency: { type: 'string' },
      locale: { type: 'string' },
      timezone: { type: 'string' },
      'data-region': { type: 'string' },
      'business-types': { type: 'string' },
      status: { type: 'string' },
      'trial-days': { type: 'string' },
      plan: { type: 'string' },
      'office-code': { type: 'string' },
      'office-name': { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-name': { type: 'string' },
    },
  });

  const trialDays = values['trial-days'];
  return {
    staffEmail: values['staff-email'] ?? '',
    legalName: values['legal-name'] ?? '',
    tradingName: values['trading-name'],
    slug: values.slug ?? '',
    countryCode: values.country ?? '',
    jurisdictionCode: values.jurisdiction,
    currencyCode: values.currency,
    localeCode: values.locale,
    timezone: values.timezone,
    dataRegion: values['data-region'] ?? '',
    businessTypes: values['business-types']?.split(',').map((type) => type.trim()) as ProvisionCompanyInput['businessTypes'],
    status: values.status as ProvisionCompanyInput['status'],
    trialDays: trialDays === undefined ? undefined : Number(trialDays),
    planCode: values.plan,
    office: { code: values['office-code'] ?? '', name: values['office-name'] ?? '' },
    owner: { email: values['owner-email'] ?? '', displayName: values['owner-name'] ?? '' },
  };
}
