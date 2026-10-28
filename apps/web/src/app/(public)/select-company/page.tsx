import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { EmptyState } from '@/components/ui/feedback';
import { isApiError, serverApi } from '@/server/api';
import { myMemberships, pageContext } from '@/server/context';
import { safeReturnTo } from '@/server/return-to';
import { sessionId, sessionStore } from '@/server/session';

import styles from '../public.module.css';
import { CompanyPicker, type PickerCompany } from './picker';

export const metadata: Metadata = { title: 'Choose a company' };

const BLOCKED = new Set(['suspended', 'cancelled']);

/**
 * S-1 company picker. Lists the user's memberships; with exactly one staff
 * membership in an open company it is chosen without asking.
 */
export default async function SelectCompanyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params['returnTo']);
  const context = await pageContext();
  if (!context.signedIn) redirect(`/sign-in?returnTo=${encodeURIComponent(`/select-company?returnTo=${encodeURIComponent(returnTo)}`)}`);
  const me = await myMemberships();
  const companies: PickerCompany[] = me.memberships.map((membership) => ({
    companyId: membership.companyId,
    companyName: membership.companyName,
    roleName: membership.roleName,
    status: membership.companyStatus,
    openable: membership.membershipType === 'staff' && !BLOCKED.has(membership.companyStatus),
    portal: membership.membershipType === 'portal',
  }));
  const openable = companies.filter((company) => company.openable);
  if (openable.length === 1 && companies.length === 1 && context.session === null) {
    const only = openable[0]!;
    const id = await sessionId();
    try {
      await serverApi('/api/v1/me/context', { companyId: only.companyId });
      if (id !== null) await sessionStore().selectCompany(id, only.companyId);
    } catch (error) {
      if (!isApiError(error)) throw error;
    }
    if (id !== null) redirect(returnTo === '/' ? '/dashboard' : returnTo);
  }
  const t = await getTranslations('auth');
  return (
    <main className={styles.frame}>
      <div className={styles.card}>
        <p className={styles.brand}>EstatePro</p>
        <h1>{t('chooseTitle')}</h1>
        {companies.length === 0 ? (
          <EmptyState title={t('noCompanies')}>{t('noCompaniesDetail')}</EmptyState>
        ) : (
          <>
            <p>{t('chooseIntro')}</p>
            <CompanyPicker companies={companies} currentCompanyId={context.session?.company.id ?? null} returnTo={returnTo === '/' ? '/dashboard' : returnTo} email={me.email} />
          </>
        )}
      </div>
    </main>
  );
}
