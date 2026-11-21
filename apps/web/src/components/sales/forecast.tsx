'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import { useSession } from '@/components/session';
import { ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { SegmentedControl, SelectField, TextField } from '@/components/ui/fields';
import { Page, PageHeader } from '@/components/ui/layout';
import tableStyles from '@/components/ui/table.module.css';
import type { ForecastDto, PipelineTotalDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { useOffices } from '@/lib/hooks/reference';
import { todayIn } from '@/lib/time';

import { MoneyText } from './sales-labels';
import styles from './sales.module.css';
import { forecastScale, monthEnd } from './sales-rules';
import { useNarrow } from './use-sales';

interface Row {
  key: string;
  label: string;
  totals: PipelineTotalDto[];
  href: string;
  warning?: boolean;
}

/**
 * FC-1 forecast: open deals by expected close month, expected value ×
 * probability, per currency and never converted (S3-D14). Bars are
 * decorative; the table carries the values. Tablet and desktop only (W-D4).
 */
export function Forecast() {
  const t = useTranslations('sales');
  const format = useFormat();
  const { session } = useSession();
  const params = useListParams();
  const narrow = useNarrow();
  const { offices } = useOffices('deal.view');
  const dealType = params.get('dealType') === 'letting' ? 'letting' : 'sale';
  const from = params.get('from') ?? todayIn(session.timezone).slice(0, 7);
  const months = params.get('months') ?? '12';
  const officeId = params.get('officeId');
  const owner = params.get('owner') === 'me' ? 'me' : null;
  const forecast = useQuery({
    queryKey: ['list', 'forecast', dealType, from, months, officeId, owner],
    queryFn: ({ signal }) => bff<ForecastDto>(`deals/forecast${query({ dealType, from, months, officeId, ownerMembershipId: owner })}`, { signal }),
  });
  const base = `/deals?filter[dealType]=${dealType}${officeId ? `&filter[officeId]=${officeId}` : ''}${owner ? '&filter[ownerMembershipId]=me' : ''}`;
  const monthLabel = (month: string) => new Intl.DateTimeFormat(format.locale, { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(`${month}-01T00:00:00Z`));
  const today = todayIn(session.timezone);

  const rows: Row[] = forecast.data
    ? [
        { key: 'overdue', label: t('overdueRow'), totals: forecast.data.overdue, href: `${base}&filter[expectedCloseDate][lte]=${today}`, warning: true },
        ...forecast.data.months.map((month) => ({ key: month.month, label: monthLabel(month.month), totals: month.totals, href: `${base}&filter[expectedCloseDate][gte]=${month.month}-01&filter[expectedCloseDate][lte]=${monthEnd(month.month)}` })),
        { key: 'undated', label: t('undatedRow'), totals: forecast.data.undated, href: base },
      ]
    : [];
  const scale = forecastScale(rows.flatMap((row) => row.totals));

  return (
    <Page>
      <PageHeader title={t('forecastTitle')} />
      {narrow ? <Notice tone="info" title={t('forecastWider')} /> : null}
      <div className={styles.actions} role="group" aria-label={t('forecastFilters')}>
        <SegmentedControl label={t('dealType')} value={dealType} onChange={(value) => params.set({ dealType: value === 'sale' ? null : value })} options={(['sale', 'letting'] as const).map((id) => ({ id, label: t(`dealTypeName.${id}`) }))} />
        <TextField label={t('fromMonth')} type="text" value={from} onChange={(value) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? params.set({ from: value }) : undefined)} dir="ltr" placeholder="2026-11" />
        <SelectField label={t('forMonths')} value={months} onChange={(value) => params.set({ months: value === '12' ? null : value })} options={['3', '6', '12', '24'].map((id) => ({ id, label: t('monthCount', { count: Number(id) }) }))} />
        {offices.length > 1 ? <SelectField label={t('office')} value={officeId ?? ''} onChange={(value) => params.set({ officeId: value || null })} options={[{ id: '', label: t('allOffices') }, ...offices.map((office) => ({ id: office.id, label: office.name }))]} /> : null}
        <SegmentedControl label={t('owner')} value={owner ?? 'anyone'} onChange={(value) => params.set({ owner: value === 'me' ? 'me' : null })} options={[{ id: 'anyone', label: t('ownerAnyone') }, { id: 'me', label: t('ownerMe') }]} />
      </div>
      <RefreshBar active={forecast.isFetching && !forecast.isPending} />
      {forecast.isPending ? (
        <Skeleton />
      ) : forecast.isError ? (
        <ErrorNotice error={forecast.error} onRetry={() => void forecast.refetch()} />
      ) : (
        <div className={tableStyles.region}>
          <table className={tableStyles.table}>
            <caption>{t('forecastCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('month')}</th>
                <th scope="col">{t('currency')}</th>
                <th scope="col">{t('deals')}</th>
                <th scope="col">{t('expected')}</th>
                <th scope="col">{t('weighted')}</th>
                <th scope="col">
                  <span className="ep-visually-hidden">{t('bar')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                row.totals.length === 0 ? (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    <td>—</td>
                    <td className="ep-num">0</td>
                    <td>—</td>
                    <td>—</td>
                    <td />
                  </tr>
                ) : (
                  row.totals.map((total, index) => (
                    <tr key={`${row.key}-${total.currency}`}>
                      {index === 0 ? (
                        <th scope="row" rowSpan={row.totals.length}>
                          <NextLink href={row.href}>{row.label}</NextLink>
                          {row.warning ? (
                            <span>
                              {' '}
                              <span aria-hidden="true">⚠ </span>
                              {t('closeDatePassed')}
                            </span>
                          ) : null}
                        </th>
                      ) : null}
                      <td>{total.currency}</td>
                      <td className="ep-num">{format.number(total.count)}</td>
                      <td>
                        <MoneyText money={total.expectedValue} />
                      </td>
                      <td>
                        <MoneyText money={total.weightedValue} />
                      </td>
                      <td aria-hidden="true">
                        <span className={styles.bar} style={{ inlineSize: `${Math.round((scale.get(total.currency) ? Number(total.weightedValue.amount) / scale.get(total.currency)! : 0) * 100)}%` }} />
                      </td>
                    </tr>
                  ))
                ),
              )}
            </tbody>
          </table>
          <p className={styles.meta}>{t('forecastNote')}</p>
        </div>
      )}
    </Page>
  );
}
