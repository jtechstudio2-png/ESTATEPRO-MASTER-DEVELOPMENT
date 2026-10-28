import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { buttonClass } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { pageContext } from '@/server/context';
import { safeReturnTo } from '@/server/return-to';

import styles from '../public.module.css';

export const metadata: Metadata = { title: 'Sign in' };

const ERRORS = { expired: 'errorExpired', denied: 'errorDenied', failed: 'errorFailed' } as const;

/** Start of S-1: sends the user to the identity provider (W-D9). */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params['returnTo']);
  const context = await pageContext();
  if (context.signedIn) redirect(context.session === null ? `/select-company?returnTo=${encodeURIComponent(returnTo)}` : returnTo);
  const t = await getTranslations('auth');
  const error = params['error'] as keyof typeof ERRORS | undefined;
  return (
    <main className={styles.frame}>
      <div className={styles.card}>
        <p className={styles.brand}>EstatePro</p>
        <h1>{t('signInTitle')}</h1>
        {params['signedOut'] === '1' ? <Notice tone="success" title={t('signedOut')} /> : null}
        {error && error in ERRORS ? <Notice tone="danger" title={t(ERRORS[error])} /> : null}
        <p>{t('signInIntro')}</p>
        <div>
          <a className={buttonClass('primary')} href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
            {t('signIn')}
          </a>
        </div>
      </div>
    </main>
  );
}
