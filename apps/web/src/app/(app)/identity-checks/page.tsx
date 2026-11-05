import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { IdentityChecks } from '@/components/contacts/identity-checks';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('identity'))('queueTitle') };
}

export default function IdentityChecksPage() {
  return <IdentityChecks />;
}
