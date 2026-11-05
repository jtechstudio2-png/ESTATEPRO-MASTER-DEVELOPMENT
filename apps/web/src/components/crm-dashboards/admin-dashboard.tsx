'use client';

import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import styles from '@/components/dashboard/dashboard.module.css';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { SelectField } from '@/components/ui/fields';
import { Cluster, Page, PageHeader, Panel } from '@/components/ui/layout';
import { When } from '@/components/ui/when';
import type { AdminDashboardDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { useOffices } from '@/lib/hooks/reference';

/** Web lists behind the API's attention items; null where the list is not built yet. */
const ATTENTION_ROUTES: Record<string, string> = {
  unassigned_leads: '/leads?tab=unassigned',
  response_overdue: '/leads?tab=open&filter[attention]=response_overdue',
  identity_checks_expiring: '/identity-checks?queue=expiring',
};
const KNOWN_ATTENTION = ['unassigned_leads', 'response_overdue', 'expired_invitations', 'identity_checks_expiring', 'failed_imports', 'agent_licences'];

/**
 * D-A admin dashboard (MD-2): is the account set up correctly and secure, is
 * CRM work flowing, and is anything blocked? Figures the product cannot know
 * yet (MFA held by the identity provider; data-subject requests before E6)
 * read "not available", never zero (C4-D7).
 */
export function AdminDashboard() {
  const t = useTranslations('adminDashboard');
  const exportsText = useTranslations('exports');
  const client = useQueryClient();
  const params = useListParams();
  const format = useFormat();
  const { offices } = useOffices('user.manage');
  const fetching = useIsFetching({ queryKey: ['dashboard', 'admin'] });
  const officeId = params.get('officeId') ?? '';
  const dashboard = useQuery({
    queryKey: ['dashboard', 'admin', officeId],
    queryFn: () => bff<AdminDashboardDto>(`dashboards/admin${query({ officeId: officeId || undefined })}`),
  });
  const data = dashboard.data;

  const row = (label: ReactNode, value: number | null, href?: string | null, warn = false) => {
    const content = (
      <>
        <span>{label}</span>
        <span className={`${styles.count} ${warn && value !== null && value > 0 ? styles.warn : ''}`}>{value === null ? <span className={styles.quiet}>{t('notAvailable')}</span> : format.number(value)}</span>
      </>
    );
    return (
      <li>
        {href && value !== null ? (
          <NextLink className={styles.countLink} href={href}>
            {content}
          </NextLink>
        ) : (
          <span className={styles.countLink}>{content}</span>
        )}
      </li>
    );
  };

  return (
    <Page>
      <PageHeader
        title={t('title')}
        actions={
          <Cluster>
            {dashboard.dataUpdatedAt > 0 ? <span className={styles.updated}>{t.rich('updated', { time: () => <When iso={new Date(dashboard.dataUpdatedAt).toISOString()} /> })}</span> : null}
            <Button onPress={() => void client.invalidateQueries({ queryKey: ['dashboard', 'admin'] })} busy={fetching > 0}>
              {t('refresh')}
            </Button>
          </Cluster>
        }
      />
      {offices.length > 1 ? (
        <div className={styles.filters}>
          <SelectField label={t('office')} value={officeId} onChange={(value) => params.set({ officeId: value || null })} options={[{ id: '', label: t('allOffices') }, ...offices.map((office) => ({ id: office.id, label: office.name }))]} />
        </div>
      ) : null}
      <RefreshBar active={fetching > 0 && dashboard.dataUpdatedAt > 0} />
      {dashboard.isPending ? (
        <div aria-busy="true" aria-label={t('title')}>
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : dashboard.isError ? (
        <ErrorNotice error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      ) : (
        <>
          <Panel title={t('attentionTitle')}>
            {data!.needsAttention.length === 0 ? (
              <p>{t('allClear')}</p>
            ) : (
              <ul className={styles.list}>
                {data!.needsAttention.map((item) => {
                  const text = KNOWN_ATTENTION.includes(item.code) ? t(`attention.${item.code as 'unassigned_leads'}`, { count: item.count }) : `${item.message} (${item.count})`;
                  const href = ATTENTION_ROUTES[item.code];
                  return (
                    <li key={item.code} className={styles.keyRow}>
                      <span>
                        <span aria-hidden="true">⚠ </span>
                        {text}
                      </span>
                      {href ? <NextLink href={href}>{t('open')}</NextLink> : <span className={styles.quiet}>{t('noListYet')}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          <div className={styles.grid}>
            <Panel title={t('usersTitle')}>
              <ul className={styles.counts}>
                {row(t('pendingInvitations'), data!.usersAndAccess.pendingInvitations)}
                {row(t('expiredInvitations'), data!.usersAndAccess.expiredInvitations, null, true)}
                {row(t('withoutMfa'), data!.usersAndAccess.usersWithoutRequiredMfa)}
                {row(t('licencesExpiring'), data!.usersAndAccess.agentLicencesExpiring, null, true)}
              </ul>
              <p className={styles.quiet}>{t('mfaNote')}</p>
            </Panel>
            <Panel title={t('flowTitle', { days: data!.leadFlow.days })}>
              {data!.leadFlow.offices.length === 0 ? (
                <p>{t('noLeads')}</p>
              ) : (
                <div className={styles.tableRegion} role="region" aria-label={t('flowCaption')} tabIndex={0}>
                  <table className={styles.table}>
                    <caption className="ep-visually-hidden">{t('flowCaption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('office')}</th>
                        <th scope="col">{t('newLeads')}</th>
                        <th scope="col">{t('unassigned')}</th>
                        <th scope="col">{t('pastTarget')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.leadFlow.offices.map((office) => (
                        <tr key={office.office?.id ?? 'none'}>
                          <th scope="row">{office.office ? <bdi>{office.office.name}</bdi> : t('noOffice')}</th>
                          <td className="ep-num">{format.number(office.newLeads)}</td>
                          <td className="ep-num">
                            {office.office ? (
                              <NextLink href={`/leads?tab=unassigned&filter[officeId]=${office.office.id}`}>{format.number(office.unassigned)}</NextLink>
                            ) : (
                              format.number(office.unassigned)
                            )}
                          </td>
                          <td className="ep-num">{office.noResponsePastTarget === null ? t('targetNotSet') : format.number(office.noResponsePastTarget)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data!.leadFlow.responseTargetMinutes === null ? (
                <p>
                  {t('targetNotSetLong')} <NextLink href="/settings/crm">{t('setTarget')}</NextLink>
                </p>
              ) : null}
            </Panel>
            <Panel title={t('qualityTitle')}>
              <ul className={styles.counts}>
                {row(t('duplicates'), data!.dataQuality.possibleDuplicateGroups)}
                {row(t('noOwner'), data!.dataQuality.contactsWithoutOwner)}
                {row(t('documentsExpiring'), data!.dataQuality.identityDocumentsExpiring, null, true)}
                {row(t('checksExpiring'), data!.dataQuality.identityChecksExpiring, '/identity-checks?queue=expiring', true)}
              </ul>
            </Panel>
            <Panel title={t('privacyTitle')}>
              <ul className={styles.counts}>
                {row(t('subjectRequests'), data!.privacy.dataSubjectRequestsOpen)}
                {row(t('withdrawals'), data!.privacy.marketingWithdrawals)}
                {row(t('reveals'), data!.privacy.sensitiveReveals)}
                {row(t('exports'), data!.privacy.exports, '/exports')}
              </ul>
              <p className={styles.quiet}>{t('privacyNote')}</p>
            </Panel>
            <Panel title={t('exportsTitle')}>
              {data!.importsExports.recentExports.length === 0 ? (
                <p>{t('noExports')}</p>
              ) : (
                <ul className={styles.list}>
                  {data!.importsExports.recentExports.map((job) => (
                    <li key={job.id} className={styles.keyRow}>
                      <span>
                        {t('exportLine', { type: exportsText(`type.${job.exportType as 'contacts'}`), status: exportsText(`statusValue.${job.status as 'completed'}`), rows: job.rowCount ?? 0, name: job.requestedBy.name })}
                      </span>
                      <When iso={job.createdAt} />
                    </li>
                  ))}
                </ul>
              )}
              <ul className={styles.counts}>{row(t('failedImports'), data!.importsExports.failedImports, null, true)}</ul>
              <NextLink href="/exports">{t('allExports')}</NextLink>
            </Panel>
            <Panel title={t('accountTitle')}>
              <ul className={styles.counts}>
                <li>
                  <span className={styles.countLink}>
                    <span>{t('seats')}</span>
                    <span className={styles.count}>
                      {data!.account.users.limit === null ? format.number(data!.account.users.used) : t('usedOf', { used: format.number(data!.account.users.used), limit: format.number(data!.account.users.limit) })}
                    </span>
                  </span>
                </li>
                <li>
                  <span className={styles.countLink}>
                    <span>{t('storage')}</span>
                    <span className={styles.count}>
                      {data!.account.storage.limit === null ? format.bytes(data!.account.storage.used) : t('usedOf', { used: format.bytes(data!.account.storage.used), limit: format.bytes(data!.account.storage.limit) })}
                    </span>
                  </span>
                </li>
                {row(t('supportGrants'), data!.account.supportAccessGrantsOpen)}
              </ul>
            </Panel>
          </div>
          <Notice tone="info">{t('scopeNote')}</Notice>
        </>
      )}
    </Page>
  );
}
