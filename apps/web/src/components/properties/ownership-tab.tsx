'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Panel, Stack } from '@/components/ui/layout';
import type { OwnershipDto, OwnershipListDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';

/** Today in the browser's calendar; the API judges dates in the property time zone and answers if they differ. */
const todayLocal = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

export function useOwnerships(propertyId: string) {
  return useQuery({
    queryKey: ['record', 'ownerships', propertyId],
    queryFn: ({ signal }) => bff<OwnershipListDto>(`properties/${propertyId}/ownerships`, { signal }),
  });
}

/**
 * Property "Ownership" tab (Phase 3 IA "Ownership records"; LL-1 "add
 * ownership"): current and past owners, their shares and whether each
 * owner's identity is verified (issue #18). Records are added and ended,
 * never edited. Owners the member cannot see are shown without a name.
 */
export function OwnershipTab({ propertyId }: { propertyId: string }) {
  const t = useTranslations('ownership');
  const common = useTranslations('common');
  const format = useFormat();
  const { can, readOnly } = useSession();
  const result = useOwnerships(propertyId);
  const [ending, setEnding] = useState<OwnershipDto | null>(null);

  if (result.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton />
        <Skeleton />
      </div>
    );
  }
  if (result.isError) return <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />;

  const canManage = result.data.canManage && !readOnly;
  const current = result.data.data.filter((row) => row.current);
  const past = result.data.data.filter((row) => !row.current);
  const ownerName = (row: OwnershipDto) => row.owner?.name ?? t('hiddenOwner');

  const table = (rows: OwnershipDto[], caption: string, withActions: boolean) => (
    <DataTable
      caption={caption}
      rows={rows}
      rowKey={(row) => row.id}
      identifier={{
        header: t('owner'),
        label: (row) =>
          row.owner ? (
            <NextLink href={`/contacts/${row.owner.id}`}>
              <bdi dir="auto">{row.owner.name}</bdi>
            </NextLink>
          ) : (
            <em>{t('hiddenOwner')}</em>
          ),
        secondary: (row) => (row.endReason ? <span dir="auto">{t('endedBy', { name: row.endedBy?.name ?? '—', date: row.endedAt ? format.date(row.endedAt) : '—', reason: row.endReason })}</span> : null),
      }}
      status={{
        header: t('identity'),
        cell: (row) =>
          row.owner?.identityVerified === true ? (
            <StatusLabel tone="success">{t('identityVerified')}</StatusLabel>
          ) : row.owner?.identityVerified === false ? (
            <span>
              <StatusLabel tone="warning" icon="⚠">
                {t('identityNotVerified')}
              </StatusLabel>{' '}
              {can('kyc.view') ? <NextLink href={`/contacts/${row.owner.id}/identity`}>{t('verifyLink')}</NextLink> : null}
            </span>
          ) : (
            t('identityUnknown')
          ),
      }}
      columns={[
        { key: 'covers', header: t('covers'), cell: (row) => (row.unit ? <bdi>{row.unit.unitLabel}</bdi> : t('wholeProperty')), onCard: true },
        { key: 'share', header: t('share'), cell: (row) => <span className="ep-num">{t('shareValue', { share: format.number(row.sharePercent, { maximumFractionDigits: 4 }) })}</span>, align: 'end', onCard: true },
        { key: 'type', header: t('type'), cell: (row) => t(`typeLabel.${row.ownershipType}`), onCard: true },
        { key: 'from', header: t('from'), cell: (row) => format.date(row.effectiveFrom), onCard: true },
        { key: 'until', header: t('until'), cell: (row) => (row.effectiveTo ? format.date(row.effectiveTo) : t('noEnd')) },
      ]}
      {...(withActions
        ? {
            actions: (row: OwnershipDto) => (
              <Button size="small" onPress={() => setEnding(row)} aria-label={t('endActionFor', { name: ownerName(row) })}>
                {t('endAction')}
              </Button>
            ),
            actionsHeader: common('actions'),
          }
        : {})}
    />
  );

  return (
    <Stack>
      <Panel
        title={t('current')}
        actions={
          canManage ? (
            <LinkButton variant="primary" href={`/ownerships/new?propertyId=${propertyId}`}>
              {t('add')}
            </LinkButton>
          ) : undefined
        }
      >
        <p>{t('intro')}</p>
        {current.length === 0 ? (
          <EmptyState headingLevel={3} title={t('empty')}>
            {t('emptyDetail')}
          </EmptyState>
        ) : (
          table(current, t('list'), canManage)
        )}
      </Panel>
      {past.length > 0 ? <Panel title={t('past')}>{table(past, t('pastList'), false)}</Panel> : null}
      {ending ? <EndOwnershipDialog record={ending} name={ownerName(ending)} onClose={() => setEnding(null)} /> : null}
    </Stack>
  );
}

function EndOwnershipDialog({ record, name, onClose }: { record: OwnershipDto; name: string; onClose: () => void }) {
  const t = useTranslations('ownership');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [effectiveTo, setEffectiveTo] = useState(todayLocal());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ids = { date: useId(), reason: useId() };
  const fieldErrors = fieldErrorsOf(error);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await bff<OwnershipDto>(`property-ownerships/${record.id}/end`, { method: 'POST', body: { effectiveTo, reason: reason.trim() } });
      announce(t('ended'));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('endTitle')}
      consequence={t('endConsequence')}
      confirmLabel={t('endActionFor', { name })}
      onConfirm={() => void submit()}
      busy={busy}
      danger
      canConfirm={reason.trim().length >= 3 && effectiveTo !== ''}
    >
      <FormProblem error={error} fields={{ effectiveTo: { label: t('lastDay'), id: ids.date }, reason: { label: t('reason'), id: ids.reason } }} />
      <TextField id={ids.date} label={t('lastDay')} description={t('lastDayHelp')} type="date" value={effectiveTo} onChange={setEffectiveTo} isRequired min={record.effectiveFrom} max={todayLocal()} error={fieldErrors['effectiveTo']} />
      <TextField id={ids.reason} label={t('reason')} description={t('reasonHelp')} value={reason} onChange={setReason} isRequired maxLength={500} dir="auto" error={fieldErrors['reason']} />
    </ConfirmDialog>
  );
}
