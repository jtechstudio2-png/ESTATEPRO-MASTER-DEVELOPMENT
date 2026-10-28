'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { ErrorNotice, Skeleton } from '@/components/ui/feedback';
import { Facts, Page, PageHeader, Panel } from '@/components/ui/layout';
import type { StorageUsageDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';

/** G-8 storage usage: company totals only (M-D4). */
export function StorageSettings() {
  const t = useTranslations('media.storage');
  const format = useFormat();
  const storage = useQuery({ queryKey: ['settings', 'storage'], queryFn: () => bff<StorageUsageDto>('settings/storage') });
  const data = storage.data;
  return (
    <Page>
      <PageHeader title={t('title')} />
      <Panel title={data?.planCode ? t('plan', { plan: data.planCode }) : t('planNone')}>
        {storage.isPending ? (
          <Skeleton />
        ) : storage.isError ? (
          <ErrorNotice error={storage.error} onRetry={() => void storage.refetch()} />
        ) : (
          <>
            <Facts
              items={[
                { label: t('planNone'), value: data!.limitBytes !== null ? t('limit', { limit: format.bytes(data!.limitBytes) }) : t('unlimited') },
                { label: t('meter'), value: <span className="ep-num">{t('used', { used: format.bytes(data!.usedBytes) })}</span> },
                { label: t('reservedLabel'), value: <span className="ep-num">{format.bytes(data!.reservedBytes)}</span> },
              ]}
            />
            {data!.limitBytes !== null ? (
              <meter min={0} max={data!.limitBytes} value={data!.usedBytes + data!.reservedBytes} high={data!.limitBytes * 0.9} aria-label={t('meter')} style={{ inlineSize: '100%' }}>
                {format.number((data!.usedBytes / data!.limitBytes) * 100, { maximumFractionDigits: 1 })}%
              </meter>
            ) : null}
            <p>{t('archivedNote')}</p>
          </>
        )}
      </Panel>
    </Page>
  );
}
