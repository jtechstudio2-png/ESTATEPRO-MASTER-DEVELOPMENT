'use client';

import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import { Ltr } from '@/components/crm/labels';
import styles from '@/components/dashboard/dashboard.module.css';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ErrorNotice, RefreshBar, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { SegmentedControl, SelectField } from '@/components/ui/fields';
import { Cluster, Page, PageHeader, Panel } from '@/components/ui/layout';
import { When } from '@/components/ui/when';
import type { CrmDashboardDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { useOffices, usePicklist } from '@/lib/hooks/reference';

const PERIODS = ['7', '30', '90'] as const;

/** "1 h 05" or "22 min" from minutes (D-C response times). */
export function useMinutesText() {
  const t = useTranslations('crmDashboard');
  return (minutes: number | null) => {
    if (minutes === null) return '—';
    const rounded = Math.round(minutes);
    if (rounded < 60) return t('minutes', { minutes: rounded });
    return t('hoursMinutes', { hours: Math.floor(rounded / 60), minutes: String(rounded % 60).padStart(2, '0') });
  };
}

/**
 * D-C CRM dashboard: are enquiries answered quickly, and is anyone's
 * follow-up slipping? Every number is computed in the viewer's scope and
 * links to the list that produced it. "Converted" stays hidden until Phase 6
 * deals exist; the response target reads "not set" until a company sets one.
 */
export function CrmDashboard() {
  const t = useTranslations('crmDashboard');
  const crm = useTranslations('crm');
  const { session, can, grant } = useSession();
  const params = useListParams();
  const client = useQueryClient();
  const format = useFormat();
  const minutes = useMinutesText();
  const sources = usePicklist('lead_source');
  const { offices } = useOffices('lead.view');
  const fetching = useIsFetching({ queryKey: ['dashboard', 'crm'] });
  const officeId = params.get('officeId') ?? '';
  const days = PERIODS.includes(params.get('days') as (typeof PERIODS)[number]) ? params.get('days')! : '30';
  const dashboard = useQuery({
    queryKey: ['dashboard', 'crm', officeId, days, session.timezone],
    queryFn: () => bff<CrmDashboardDto>(`dashboards/crm${query({ officeId: officeId || undefined, days, timezone: session.timezone })}`),
  });
  const sourceLabel = (code: string) => sources.data?.data.find((value) => value.code === code)?.label ?? code;
  const own = grant('lead.view')?.scope === 'own';
  const data = dashboard.data;
  const officeFilter = officeId ? `&filter[officeId]=${officeId}` : '';
  const fromFilter = data ? `&filter[receivedAt][gte]=${encodeURIComponent(data.scope.from)}` : '';
  const target = data?.responseTargetMinutes ?? null;

  return (
    <Page>
      <PageHeader
        title={t('title')}
        subtitle={own ? t('scopeOwn') : officeId ? (offices.find((office) => office.id === officeId)?.name ?? '') : t('scopeAll')}
        actions={
          <Cluster>
            {dashboard.dataUpdatedAt > 0 ? <span className={styles.updated}>{t.rich('updated', { time: () => <When iso={new Date(dashboard.dataUpdatedAt).toISOString()} /> })}</span> : null}
            <Button onPress={() => void client.invalidateQueries({ queryKey: ['dashboard', 'crm'] })} busy={fetching > 0}>
              {t('refresh')}
            </Button>
          </Cluster>
        }
      />
      <div className={styles.filters}>
        {offices.length > 1 && !own ? (
          <SelectField label={t('office')} value={officeId} onChange={(value) => params.set({ officeId: value || null })} options={[{ id: '', label: t('allOffices') }, ...offices.map((office) => ({ id: office.id, label: office.name }))]} />
        ) : null}
        <SegmentedControl label={t('period')} value={days} onChange={(value) => params.set({ days: value === '30' ? null : value })} options={PERIODS.map((id) => ({ id, label: t('lastDays', { days: Number(id) }) }))} />
      </div>
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
        <div className={styles.grid}>
          <Panel title={t('waitingTitle', { count: data!.newNotContacted.total })}>
            {data!.newNotContacted.items.length === 0 ? (
              <p>{t('waitingNone')}</p>
            ) : (
              <div className={styles.tableRegion} role="region" aria-label={t('waitingCaption')} tabIndex={0}>
                <table className={styles.table}>
                  <caption className="ep-visually-hidden">{t('waitingCaption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('received')}</th>
                      <th scope="col">{t('contact')}</th>
                      <th scope="col">{t('source')}</th>
                      <th scope="col">{t('assigned')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.newNotContacted.items.map((lead) => (
                      <tr key={lead.id}>
                        <td>
                          <When iso={lead.receivedAt} />
                          {lead.overdue ? (
                            <>
                              {' '}
                              <StatusLabel tone="danger" icon="⚠">
                                {t('pastTarget')}
                              </StatusLabel>
                            </>
                          ) : null}
                        </td>
                        <th scope="row">
                          <NextLink href={`/leads/${lead.id}`}>
                            <bdi dir="auto">{lead.contactName}</bdi> · <Ltr>{lead.reference}</Ltr>
                          </NextLink>
                        </th>
                        <td>{sourceLabel(lead.sourceCode)}</td>
                        <td>{lead.assignedTo ? <bdi>{lead.assignedTo.name}</bdi> : t('unassigned')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <NextLink href="/leads">{t('openInbox')}</NextLink>
          </Panel>

          <Panel title={t('followUpsTitle')}>
            <ul className={styles.counts}>
              {(['overdue', 'today', 'thisWeek'] as const).map((kind) => (
                <li key={kind}>
                  <NextLink className={styles.countLink} href={`/follow-ups?range=${kind === 'thisWeek' ? 'week' : kind}${data!.followUps.view === 'team' ? '&tab=team' : ''}`}>
                    <span>{t(`followUps.${kind}`)}</span>
                    <span className={`${styles.count} ${kind === 'overdue' && data!.followUps.overdue > 0 ? styles.warn : ''}`}>
                      {kind === 'overdue' && data!.followUps.overdue > 0 ? <span aria-hidden="true">⚠ </span> : null}
                      {format.number(data!.followUps[kind])}
                    </span>
                  </NextLink>
                </li>
              ))}
            </ul>
            <p className={styles.quiet}>{data!.followUps.view === 'team' ? t('followUpsTeam') : t('followUpsMine')}</p>
          </Panel>

          <Panel title={t('statusTitle', { days: Number(days) })}>
            <ul className={styles.counts}>
              {(['new', 'contacted', 'qualified', 'unqualified', 'lost'] as const).map((status) => (
                <li key={status}>
                  <NextLink className={styles.countLink} href={`/leads?tab=${status === 'unqualified' || status === 'lost' ? 'closed' : 'open'}&filter[status]=${status}${officeFilter}${fromFilter}`}>
                    <span>{crm(`leadStatus.${status}`)}</span>
                    <span className={styles.count}>{format.number(data!.leadsByStatus[status])}</span>
                  </NextLink>
                </li>
              ))}
            </ul>
          </Panel>

          {data!.requirements ? (
            <Panel title={t('requirementsTitle')}>
              <ul className={styles.counts}>
                <li>
                  <NextLink className={styles.countLink} href="/requirements?filter[requirementType]=buy">
                    <span>{t('buy')}</span>
                    <span className={styles.count}>{format.number(data!.requirements.buy)}</span>
                  </NextLink>
                </li>
                <li>
                  <NextLink className={styles.countLink} href="/requirements?filter[requirementType]=rent">
                    <span>{t('rent')}</span>
                    <span className={styles.count}>{format.number(data!.requirements.rent)}</span>
                  </NextLink>
                </li>
                {data!.requirements.noMatch !== null ? (
                  <li>
                    <NextLink className={styles.countLink} href="/requirements">
                      <span>{t('noMatch')}</span>
                      <span className={styles.count}>{format.number(data!.requirements.noMatch)}</span>
                    </NextLink>
                  </li>
                ) : null}
              </ul>
              {data!.requirements.noMatchCheckedAt ? (
                <p className={styles.quiet}>
                  {t.rich('noMatchChecked', { time: () => <When iso={data!.requirements!.noMatchCheckedAt!} />, pending: data!.requirements.noMatchPending ?? 0 })}
                </p>
              ) : data!.requirements.noMatch !== null ? (
                <p className={styles.quiet}>{t('noMatchNotYet')}</p>
              ) : null}
            </Panel>
          ) : null}

          {data!.responseTimes !== null ? (
            <Panel title={t('responseTitle', { days: Number(days) })}>
              {target === null ? (
                <p>
                  {t('targetNotSet')} {can('settings.manage') ? <NextLink href="/settings/crm">{t('setTarget')}</NextLink> : null}
                </p>
              ) : (
                <p className={styles.quiet}>{t('targetLine', { target: minutes(target) })}</p>
              )}
              {data!.responseTimes.length === 0 ? (
                <p>{t('noLeadsInPeriod')}</p>
              ) : (
                <div className={styles.tableRegion} role="region" aria-label={t('responseCaption')} tabIndex={0}>
                  <table className={styles.table}>
                    <caption className="ep-visually-hidden">{t('responseCaption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('agent')}</th>
                        <th scope="col">{t('leads')}</th>
                        <th scope="col">{t('median')}</th>
                        {target !== null ? <th scope="col">{t('withinTarget')}</th> : null}
                        <th scope="col">{t('qualified')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.responseTimes.map((row) => (
                        <tr key={row.assignee.id}>
                          <th scope="row">
                            <NextLink href={`/leads?tab=open&filter[assignedTo]=${row.assignee.id}${fromFilter}`}>
                              <bdi>{row.assignee.name}</bdi>
                            </NextLink>
                          </th>
                          <td className="ep-num">{format.number(row.leads)}</td>
                          <td className="ep-num">{minutes(row.medianFirstResponseMinutes)}</td>
                          {target !== null ? (
                            <td className="ep-num" title={t('percentOf', { percent: row.withinTargetPercent ?? 0, base: row.leads })}>
                              <span aria-hidden="true">{row.withinTargetPercent === null ? '—' : `${format.number(row.withinTargetPercent)} %`}</span>
                              <span className="ep-visually-hidden">{t('percentOf', { percent: row.withinTargetPercent ?? 0, base: row.leads })}</span>
                            </td>
                          ) : null}
                          <td className="ep-num">{format.number(row.qualified)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          ) : null}

          <Panel title={t('sourceTitle', { days: Number(days) })}>
            {data!.leadsBySource.length === 0 ? (
              <p>{t('noLeadsInPeriod')}</p>
            ) : (
              <div className={styles.tableRegion} role="region" aria-label={t('sourceCaption')} tabIndex={0}>
                <table className={styles.table}>
                  <caption className="ep-visually-hidden">{t('sourceCaption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('source')}</th>
                      <th scope="col">{t('leads')}</th>
                      <th scope="col">{t('qualified')}</th>
                      <th scope="col">{t('median')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.leadsBySource.map((row) => (
                      <tr key={row.sourceCode}>
                        <th scope="row">
                          <NextLink href={`/leads?tab=open&filter[sourceCode]=${row.sourceCode}${officeFilter}${fromFilter}`}>{sourceLabel(row.sourceCode)}</NextLink>
                        </th>
                        <td className="ep-num">{format.number(row.leads)}</td>
                        <td className="ep-num">{format.number(row.qualified)}</td>
                        <td className="ep-num">{minutes(row.medianFirstResponseMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </Page>
  );
}
