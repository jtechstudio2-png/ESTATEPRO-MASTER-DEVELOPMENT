'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorNotice, StatusLabel } from '@/components/ui/feedback';
import { bffRequest } from '@/lib/bff';

import styles from '../public.module.css';

export interface PickerCompany {
  companyId: string;
  companyName: string;
  roleName: string;
  status: string;
  openable: boolean;
  portal: boolean;
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info'> = {
  active: 'success',
  trial: 'info',
  past_due: 'warning',
  read_only: 'warning',
  suspended: 'danger',
  cancelled: 'danger',
};

export function CompanyPicker({ companies, currentCompanyId, returnTo, email }: { companies: PickerCompany[]; currentCompanyId: string | null; returnTo: string; email: string }) {
  const t = useTranslations('auth');
  const nav = useTranslations('nav');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const choose = async (company: PickerCompany) => {
    setBusy(company.companyId);
    setError(null);
    try {
      await bffRequest('../auth/company', { method: 'POST', body: { companyId: company.companyId } });
      // A full load: nothing cached for the previous company survives (S-1).
      window.location.assign(returnTo);
    } catch (caught) {
      setError(caught);
      setBusy(null);
    }
  };

  const signOut = async () => {
    const result = await bffRequest<{ redirectTo: string }>('../auth/logout', { method: 'POST' }).catch(() => null);
    window.location.assign(result?.data.redirectTo ?? '/sign-in?signedOut=1');
  };

  return (
    <>
      {error ? <ErrorNotice error={error} /> : null}
      <ul className={styles.companies}>
        {companies.map((company) => (
          <li key={company.companyId} className={styles.company}>
            <span className={styles.companyName}>
              <bdi>{company.companyName}</bdi>
              <br />
              <span className={styles.role}>{company.roleName}</span>
            </span>
            <StatusLabel tone={STATUS_TONE[company.status] ?? 'neutral'}>{t.has(`companyStatus.${company.status}`) ? t(`companyStatus.${company.status}`) : company.status}</StatusLabel>
            {company.portal ? (
              <span className={styles.role}>{t('portalSoon')}</span>
            ) : company.openable ? (
              <Button
                variant={company.companyId === currentCompanyId ? 'secondary' : 'primary'}
                onPress={() => void choose(company)}
                busy={busy === company.companyId}
                isDisabled={busy !== null && busy !== company.companyId}
                aria-label={t('open', { company: company.companyName })}
              >
                {t('openShort')}
              </Button>
            ) : (
              <span className={styles.role}>{t('inactive', { status: t.has(`companyStatus.${company.status}`) ? t(`companyStatus.${company.status}`) : company.status })}</span>
            )}
          </li>
        ))}
      </ul>
      <div className={styles.footer}>
        <span>{t('signedInAs', { email })}</span>
        <Button variant="quiet" onPress={() => void signOut()}>
          {nav('signOut')}
        </Button>
      </div>
    </>
  );
}
