import { getTranslations } from 'next-intl/server';

import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';

export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <main id="main" style={{ padding: 'var(--ep-space-6)' }}>
      <EmptyState title={t('notFoundTitle')} action={<LinkButton href="/dashboard">{t('home')}</LinkButton>}>
        {t('notFoundDetail')}
      </EmptyState>
    </main>
  );
}
