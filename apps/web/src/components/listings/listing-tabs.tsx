'use client';

import { useTranslations } from 'next-intl';

import { EmptyState, ErrorNotice, Skeleton } from '@/components/ui/feedback';
import { Facts, Panel, RecordLayout } from '@/components/ui/layout';
import { LoadMore } from '@/components/ui/list-controls';
import { When } from '@/components/ui/when';
import type { HistoryEntryDto, PriceHistoryEntryDto, StatusHistoryEntryDto } from '@/lib/api-schema';
import { useFormat } from '@/lib/hooks/format';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useLocales } from '@/lib/hooks/reference';

import { PublishChecklist } from './listing-dialogs';
import { PriceText, type ListingStatus } from './listing-labels';
import styles from './listings.module.css';
import { useListing, useReadiness } from './use-listing';

function daysUntil(date: string): number {
  return Math.ceil((new Date(`${date}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
}

/** L-3 overview: description, gallery counts, key facts and the publishing checklist. */
export function ListingOverview({ id }: { id: string }) {
  const t = useTranslations('listings');
  const format = useFormat();
  const listing = useListing(id);
  const record = listing.data;
  const readiness = useReadiness(id, record !== undefined && record.archivedAt === null);
  const locales = useLocales();
  if (!record) return null;
  const language = locales.data?.data.find((locale) => locale.code === record.defaultLocaleCode);
  const mandateDays = record.mandateExpiresOn ? daysUntil(record.mandateExpiresOn) : null;

  const main = (
    <Panel title={t('description', { language: language?.name ?? record.defaultLocaleCode })}>
      {record.description ? (
        <p className={styles.description} dir="auto" lang={record.defaultLocaleCode}>
          {record.description}
        </p>
      ) : (
        <p className={styles.quiet}>{t('noDescription')}</p>
      )}
      <p>{t('coverAndCounts', { photos: record.media.photoCount, plans: record.media.floorPlanCount })}</p>
    </Panel>
  );

  const aside = (
    <>
      <Panel title={t('keyFacts')}>
        <Facts
          items={[
            { label: t('price'), value: <PriceText price={record.price} rentFrequency={record.rentFrequency} /> },
            record.advanceRentPeriods !== null ? { label: t('edit.advance'), value: <span className="ep-num">{format.number(record.advanceRentPeriods)}</span> } : null,
            record.deposit ? { label: t('deposit'), value: <span className="ep-num">{format.money(record.deposit)}</span> } : null,
            record.serviceCharge ? { label: t('serviceCharge'), value: <span className="ep-num">{format.money(record.serviceCharge)}</span> } : null,
            record.minTermMonths !== null ? { label: t('edit.minTerm'), value: <span className="ep-num">{format.number(record.minTermMonths)}</span> } : null,
            record.availableFrom ? { label: t('availableFrom'), value: <When iso={record.availableFrom} dateOnly /> } : null,
            record.mandateTypeCode
              ? {
                  label: t('mandate'),
                  value: (
                    <>
                      {record.mandateTypeCode}
                      {record.mandateExpiresOn ? ` · ${t('mandateUntil', { date: format.date(record.mandateExpiresOn) })}` : ''}
                      {mandateDays !== null ? ` (${mandateDays < 0 ? t('mandateExpired') : t('mandateExpiresIn', { days: mandateDays })})` : ''}
                    </>
                  ),
                }
              : null,
            record.feeTerms
              ? {
                  label: t('fee'),
                  value: `${record.feeTerms.basis === 'percentage' ? t('feeRate', { rate: record.feeTerms.rate ?? '' }) : record.feeTerms.amount ? format.money(record.feeTerms.amount) : ''} · ${record.feeTerms.taxInclusive ? t('taxIncluded') : t('taxExcluded')}`,
                }
              : null,
            { label: t('office'), value: record.office.name },
            record.listedAt ? { label: t('listedOn'), value: <When iso={record.listedAt} /> } : null,
            record.closedAt ? { label: t('closedOn'), value: <When iso={record.closedAt} /> } : null,
          ]}
        />
      </Panel>
      {record.archivedAt === null ? (
        <Panel title={t('checklist.title')}>
          {readiness.isError ? <ErrorNotice error={readiness.error} onRetry={() => void readiness.refetch()} /> : <PublishChecklist listing={record} readiness={readiness.data} />}
        </Panel>
      ) : null}
    </>
  );
  return <RecordLayout main={main} aside={aside} asideLabel={t('keyFacts')} />;
}

function percentChange(oldAmount: string, newAmount: string, locale: string): string {
  const before = Number(oldAmount);
  if (!(before > 0)) return '';
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'always' }).format((Number(newAmount) - before) / before);
}

/** L-9 price and status history, newest first, with who made each change. */
export function PriceStatusTab({ id }: { id: string }) {
  const t = useTranslations('listings');
  const h = useTranslations('listings.history');
  const format = useFormat();
  const prices = usePagedList<PriceHistoryEntryDto>(`listings/${id}/price-history`, new URLSearchParams(), { limit: 25 });
  const statuses = usePagedList<StatusHistoryEntryDto>(`listings/${id}/status-history`, new URLSearchParams(), { limit: 25 });
  const statusName = (status: string | null) => (status === null ? '—' : t(`statusValue.${status as ListingStatus}`));
  return (
    <>
      <Panel title={h('price')}>
        {prices.isPending ? (
          <Skeleton />
        ) : prices.isError ? (
          <ErrorNotice error={prices.error} onRetry={() => void prices.refetch()} />
        ) : (
          <>
            <ol className={styles.history} aria-label={h('priceList')}>
              {prices.rows.map((entry) => (
                <li key={entry.id}>
                  <When iso={entry.changedAt} />
                  <span className="ep-num">
                    {entry.oldPrice ? h('from', { from: format.money(entry.oldPrice), to: format.money(entry.newPrice) }) : h('initialPrice', { price: format.money(entry.newPrice) })}
                  </span>
                  {entry.oldPrice ? <span className="ep-num">{percentChange(entry.oldPrice.amount, entry.newPrice.amount, format.locale)}</span> : null}
                  <span>{entry.changedByName ? h('by', { name: entry.changedByName }) : h('system')}</span>
                  {entry.approvedByName ? <span>{h('approved', { name: entry.approvedByName })}</span> : null}
                  {entry.reason ? (
                    <span dir="auto" className={styles.quiet}>
                      “{entry.reason}”
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
            <LoadMore hasMore={prices.hasNextPage} loading={prices.isFetchingNextPage} onLoad={prices.loadMore} shown={prices.rows.length} />
          </>
        )}
      </Panel>
      <Panel title={h('status')}>
        {statuses.isPending ? (
          <Skeleton />
        ) : statuses.isError ? (
          <ErrorNotice error={statuses.error} onRetry={() => void statuses.refetch()} />
        ) : (
          <>
            <ol className={styles.history} aria-label={h('statusList')}>
              {statuses.rows.map((entry) => (
                <li key={entry.id}>
                  <When iso={entry.changedAt} />
                  <span>{h('from', { from: statusName(entry.fromStatus), to: statusName(entry.toStatus) })}</span>
                  <span>{entry.changedByName ? h('by', { name: entry.changedByName }) : h('system')}</span>
                  {entry.reason ? (
                    <span dir="auto" className={styles.quiet}>
                      “{entry.reason}”
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
            <LoadMore hasMore={statuses.hasNextPage} loading={statuses.isFetchingNextPage} onLoad={statuses.loadMore} shown={statuses.rows.length} />
          </>
        )}
      </Panel>
    </>
  );
}

/** The listing's full audit feed (GET /listings/{id}/history). */
export function ListingHistoryTab({ id }: { id: string }) {
  const h = useTranslations('listings.history');
  const activity = useTranslations('properties.activity');
  const history = usePagedList<HistoryEntryDto>(`listings/${id}/history`, new URLSearchParams(), { limit: 25 });
  const describe = (action: string) => {
    const [kind, verb] = action.split('.') as [string, string | undefined];
    const key = `actions.${kind}.${verb ?? ''}`;
    return activity.has(key) ? activity(key) : action.replace(/[._]/g, ' ');
  };
  return (
    <Panel title={h('list')}>
      {history.isPending ? (
        <Skeleton />
      ) : history.isError ? (
        <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />
      ) : history.rows.length === 0 ? (
        <EmptyState headingLevel={3} title={h('empty')} />
      ) : (
        <>
          <ol className={styles.history} aria-label={h('list')}>
            {history.rows.map((entry) => (
              <li key={entry.id}>
                <When iso={entry.occurredAt} />
                <strong>{describe(entry.action)}</strong>
                <span>{entry.actorName ? h('by', { name: entry.actorName }) : h('system')}</span>
                {entry.changes ? <span className={styles.quiet}>{Object.keys(entry.changes).join(', ')}</span> : null}
              </li>
            ))}
          </ol>
          <LoadMore hasMore={history.hasNextPage} loading={history.isFetchingNextPage} onLoad={history.loadMore} shown={history.rows.length} />
        </>
      )}
    </Panel>
  );
}

