'use client';

import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { CompleteDialog } from '@/components/activity/follow-ups-list';
import { FollowUpDialog } from '@/components/activity/follow-up-dialog';
import { LogActivityDialog } from '@/components/activity/log-activity';
import { useSession } from '@/components/session';
import styles from '@/components/dashboard/dashboard.module.css';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { Cluster, Page, PageHeader, Panel } from '@/components/ui/layout';
import { When } from '@/components/ui/when';
import type { DayItemDto, MyDayDto, TaskDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { MoneyText, ZonedTime } from '@/components/sales/sales-labels';
import { ViewingDrawer } from '@/components/sales/viewing-dialogs';
import { useFormat } from '@/lib/hooks/format';

type Action = { kind: 'done' | 'reschedule'; task: TaskDto } | { kind: 'log'; item: DayItemDto } | null;

/**
 * D-M My day (MD-3, agents): one list for today in the member's time zone,
 * overdue first, each row with one primary action. Phase 6 (S6) adds the
 * viewings I conduct today (shown in the property's time zone; Open shows the
 * viewing, where its outcome is recorded) and offers awaiting a response. The list does not move
 * while it is read: it changes only on Refresh (no auto-refresh, §10).
 */
export function MyDay() {
  const t = useTranslations('myDay');
  const crm = useTranslations('crm');
  const { session, can, readOnly } = useSession();
  const client = useQueryClient();
  const format = useFormat();
  const fetching = useIsFetching({ queryKey: ['dashboard', 'my-day'] });
  const day = useQuery({
    queryKey: ['dashboard', 'my-day', session.timezone],
    queryFn: () => bff<MyDayDto>(`dashboards/my-day?timezone=${encodeURIComponent(session.timezone)}`),
    refetchOnWindowFocus: false,
  });
  const [action, setAction] = useState<Action>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  /** Done and Reschedule act on the follow-up as it is now (its version), so it is fetched first. */
  const withTask = async (item: DayItemDto, kind: 'done' | 'reschedule') => {
    setLoading(item.id);
    setError(null);
    try {
      const task = await bff<TaskDto>(`tasks/${item.id}`);
      setAction({ kind, task });
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(null);
    }
  };

  const data = day.data;
  return (
    <Page>
      <PageHeader
        title={data ? t('title', { date: format.date(data.date) }) : t('titlePlain')}
        subtitle={t('zone', { zone: session.timezone })}
        actions={
          <Cluster>
            {day.dataUpdatedAt > 0 ? <span className={styles.updated}>{t.rich('updated', { time: () => <When iso={new Date(day.dataUpdatedAt).toISOString()} /> })}</span> : null}
            <Button onPress={() => void client.invalidateQueries({ queryKey: ['dashboard', 'my-day'] })} busy={fetching > 0}>
              {t('refresh')}
            </Button>
          </Cluster>
        }
      />
      <RefreshBar active={fetching > 0 && day.dataUpdatedAt > 0} />
      {error ? <ErrorNotice error={error} /> : null}
      {day.isPending ? (
        <div aria-busy="true" aria-label={t('titlePlain')}>
          <Skeleton />
          <Skeleton />
        </div>
      ) : day.isError ? (
        <ErrorNotice error={day.error} onRetry={() => void day.refetch()} />
      ) : (
        <div className={styles.grid}>
          <Panel title={t('today')}>
            {data!.today.length === 0 ? (
              <EmptyState title={t('nothingToday')} headingLevel={3} action={<LinkButton href="/leads">{t('openLeads')}</LinkButton>}>
                {t('nothingTodayDetail')}
              </EmptyState>
            ) : (
              <ol className={styles.list}>
                {data!.today.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    <div className={styles.keyRow}>
                      <span>
                        {item.kind === 'viewing' && item.timezone ? (
                          <ZonedTime iso={item.at} timeZone={item.timezone} {...(item.endsAt ? { end: item.endsAt } : {})} />
                        ) : (
                          <time dateTime={item.at} className="ep-num">
                            {format.dateTime(item.at)}
                          </time>
                        )}{' '}
                        · {t(`kind.${item.kind as 'follow_up'}`)} ·{' '}
                        {item.amount ? (
                          <>
                            <MoneyText money={item.amount} />{' '}
                          </>
                        ) : null}
                        <bdi dir="auto">{item.title}</bdi>
                        {item.overdue ? (
                          <>
                            {' '}
                            <StatusLabel tone="danger" icon="⚠">
                              {crm('overdue')}
                            </StatusLabel>
                          </>
                        ) : null}
                      </span>
                    </div>
                    {item.about && item.aboutId ? (
                      <p className={styles.quiet}>
                        {item.aboutType === 'viewing' ? (
                          <bdi dir="auto">{item.about}</bdi>
                        ) : (
                          <NextLink href={item.aboutType === 'deal' ? `/deals/${item.aboutId}?tab=offers` : `/${item.aboutType === 'lead' ? 'leads' : 'contacts'}/${item.aboutId}`}>
                            <bdi dir="auto">{item.about}</bdi>
                          </NextLink>
                        )}
                      </p>
                    ) : null}
                    {!readOnly ? (
                      <Cluster>
                        {item.kind === 'follow_up' ? (
                          <>
                            <Button size="small" variant="primary" busy={loading === item.id} onPress={() => void withTask(item, 'done')} aria-label={t('doneNamed', { title: item.title })}>
                              {t('done')}
                            </Button>
                            {item.aboutId ? (
                              <Button size="small" onPress={() => setAction({ kind: 'log', item })} aria-label={t('logNamed', { title: item.title })}>
                                {t('logOutcome')}
                              </Button>
                            ) : null}
                            <Button size="small" onPress={() => void withTask(item, 'reschedule')} aria-label={t('rescheduleNamed', { title: item.title })}>
                              {t('reschedule')}
                            </Button>
                          </>
                        ) : item.kind === 'viewing' ? (
                          <Button size="small" variant="primary" onPress={() => setViewing(item.id)} aria-label={t('openNamed', { title: item.title })}>
                            {t('open')}
                          </Button>
                        ) : (
                          <LinkButton size="small" variant="primary" href={item.kind === 'offer' && item.aboutId ? `/deals/${item.aboutId}?tab=offers` : `/leads/${item.id}`} aria-label={t('openNamed', { title: item.title })}>
                            {t('open')}
                          </LinkButton>
                        )}
                      </Cluster>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
            {data!.laterThisWeek > 0 ? (
              <NextLink href="/follow-ups?range=week">{t('laterThisWeek', { count: data!.laterThisWeek })}</NextLink>
            ) : null}
          </Panel>
          <Panel title={t('waitingTitle')}>
            <ul className={styles.counts}>
              <li>
                <NextLink className={styles.countLink} href="/leads?tab=mine&filter[status]=new">
                  <span>{t('newLeadsAssigned')}</span>
                  <span className={styles.count}>{format.number(data!.waitingOnMe.newLeadsAssigned)}</span>
                </NextLink>
              </li>
              <li>
                <NextLink className={styles.countLink} href="/follow-ups?range=overdue">
                  <span>{t('overdueFollowUps')}</span>
                  <span className={`${styles.count} ${data!.waitingOnMe.overdueFollowUps > 0 ? styles.warn : ''}`}>{format.number(data!.waitingOnMe.overdueFollowUps)}</span>
                </NextLink>
              </li>
              <li>
                {data!.waitingOnMe.leadsPastTarget === null ? (
                  <span className={styles.countLink}>
                    <span>{t('leadsPastTarget')}</span>
                    <span className={styles.quiet}>{t('targetNotSet')}</span>
                  </span>
                ) : (
                  <NextLink className={styles.countLink} href="/leads?tab=mine&filter[attention]=response_overdue">
                    <span>{t('leadsPastTarget')}</span>
                    <span className={`${styles.count} ${data!.waitingOnMe.leadsPastTarget > 0 ? styles.warn : ''}`}>{format.number(data!.waitingOnMe.leadsPastTarget)}</span>
                  </NextLink>
                )}
              </li>
              {data!.waitingOnMe.viewingsNeedingOutcome !== null ? (
                <li>
                  <NextLink className={styles.countLink} href="/viewings/follow-up">
                    <span>{t('viewingsNeedingOutcome')}</span>
                    <span className={`${styles.count} ${data!.waitingOnMe.viewingsNeedingOutcome > 0 ? styles.warn : ''}`}>{format.number(data!.waitingOnMe.viewingsNeedingOutcome)}</span>
                  </NextLink>
                </li>
              ) : null}
              {data!.waitingOnMe.offersAwaitingResponse !== null ? (
                <li>
                  <NextLink className={styles.countLink} href="/deals?filter[ownerMembershipId]=me">
                    <span>{t('offersAwaitingResponse')}</span>
                    <span className={styles.count}>{format.number(data!.waitingOnMe.offersAwaitingResponse)}</span>
                  </NextLink>
                </li>
              ) : null}
            </ul>
          </Panel>
          <Panel title={t('myLeadsTitle')}>
            <ul className={styles.counts}>
              {(['new', 'contacted', 'qualified', 'unqualified', 'lost', 'converted'] as const).map((status) => (
                <li key={status}>
                  <NextLink className={styles.countLink} href={`/leads?tab=mine&filter[status]=${status}`}>
                    <span>{crm(`leadStatus.${status}`)}</span>
                    <span className={styles.count}>{format.number(data!.myLeadsByStatus[status])}</span>
                  </NextLink>
                </li>
              ))}
            </ul>
          </Panel>
          {!readOnly ? (
            <Panel title={t('quickTitle')}>
              <Cluster>
                {can('lead.create') ? <LinkButton href="/leads/new">{t('newLead')}</LinkButton> : null}
                {can('contact.create') ? <LinkButton href="/contacts/new">{t('newContact')}</LinkButton> : null}
                <LinkButton href="/follow-ups?compose=1">{t('newFollowUp')}</LinkButton>
                {can('viewing.manage') ? <LinkButton href="/calendar?book=1">{t('bookViewing')}</LinkButton> : null}
              </Cluster>
            </Panel>
          ) : null}
        </div>
      )}
      {viewing ? <ViewingDrawer id={viewing} onClose={() => setViewing(null)} onOpenViewing={setViewing} /> : null}
      {action?.kind === 'done' ? <CompleteDialog task={action.task} onClose={() => setAction(null)} /> : null}
      {action?.kind === 'reschedule' ? <FollowUpDialog task={action.task} onClose={() => setAction(null)} /> : null}
      {action?.kind === 'log' && action.item.aboutId ? (
        <LogActivityDialog
          links={[{ entityType: action.item.aboutType === 'lead' ? 'lead' : 'contact', entityId: action.item.aboutId, label: action.item.about ?? '' }]}
          initialType="call"
          onClose={() => setAction(null)}
        />
      ) : null}
    </Page>
  );
}
