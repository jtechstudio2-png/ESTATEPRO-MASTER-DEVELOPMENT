import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { KeyRegister } from '@/components/keys/key-register';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('keys'))('registerTitle') };
}

export default function KeysPage() {
  return <KeyRegister />;
}
