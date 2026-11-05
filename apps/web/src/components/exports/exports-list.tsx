'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton, StatusLabel, type Tone } from '@/components/ui/feedback';
import { Page, PageHeader } from '@/components/ui/layout';
import { When } from '@/components/ui/when';
import type { ExportJobDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';

import { downloadExport } from './export-dialog';

const STATUS_TONE: Record<ExportJobDto['status'], Tone> = { completed: 'success', failed: 'danger', expired: 'neutral' };

/**
 * Exports (CA-16): the member's own exports, or every export for those who
 * manage users (C4-D3). Only the person who asked may download; files are
 * deleted after 24 hours and the record stays.
 */
export function ExportsList() {
  const t = useTranslations('exports');
  const { can } = useSession();
  const format = useFormat();
  const exports = useQuery({ queryKey: ['list', 'exports'], queryFn: ({ signal }) => bff<ExportJobDto[]>('exports', { signal }) });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const download = async (job: ExportJobDto) => {
    setBusy(job.id);
    setError(null);
    try {
      await downloadExport(job.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  const rows = exports.data ?? [];
  return (
    <Page>
      <PageHeader title={t('title')} subtitle={can('user.manage') ? t('subtitleAll') : t('subtitleMine')} />
      <Notice tone="info">{t('listHelp')}</Notice>
      {error ? <ErrorNotice error={error} /> : null}
      <RefreshBar active={exports.isFetching && !exports.isPending} />
      {exports.isPending ? (
        <div aria-busy="true" aria-label={t('title')}>
          <Skeleton />
          <Skeleton />
        </div>
      ) : exports.isError ? (
        <ErrorNotice error={exports.error} onRetry={() => void exports.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('emptyTitle')}>{t('emptyDetail')}</EmptyState>
      ) : (
        <DataTable
          caption={t('title')}
          rows={rows}
          rowKey={(row) => row.id}
          identifier={{
            header: t('export'),
            label: (row) => t(`type.${row.exportType}`),
            secondary: (row) => (row.fileName ? <bdi dir="ltr">{row.fileName}</bdi> : null),
          }}
          status={{ header: t('status'), cell: (row) => <StatusLabel tone={STATUS_TONE[row.status]}>{t(`statusValue.${row.status}`)}</StatusLabel> }}
          columns={[
            { key: 'rows', header: t('rows'), cell: (row) => (row.rowCount === null ? '—' : <span className="ep-num">{format.number(row.rowCount)}</span>), align: 'end', onCard: true },
            { key: 'by', header: t('requestedBy'), cell: (row) => <bdi>{row.requestedBy.name}</bdi>, onCard: true },
            { key: 'created', header: t('created'), cell: (row) => <When iso={row.createdAt} /> },
            { key: 'expires', header: t('expires'), cell: (row) => (row.expiresAt && row.status === 'completed' ? <When iso={row.expiresAt} /> : '—') },
            { key: 'downloads', header: t('downloads'), cell: (row) => <span className="ep-num">{row.downloadCount}</span>, align: 'end' },
          ]}
          actionsHeader={t('actions')}
          actions={(row) =>
            row.status === 'completed' && row.canDownload ? (
              <Button size="small" onPress={() => void download(row)} busy={busy === row.id} aria-label={t('downloadNamed', { name: row.fileName ?? row.id })}>
                {t('download')}
              </Button>
            ) : row.status === 'completed' ? (
              <span>{t('requesterOnly')}</span>
            ) : null
          }
        />
      )}
    </Page>
  );
}
