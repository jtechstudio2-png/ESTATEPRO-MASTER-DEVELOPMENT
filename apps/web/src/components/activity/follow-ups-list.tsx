'use client';

import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { OverdueMark, PriorityLabel } from '@/components/crm/labels';
import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { DataTable } from '@/components/ui/data-table';
import { Page, PageHeader } from '@/components/ui/layout';
import { LoadMore } from '@/components/ui/list-controls';
import pillStyles from '@/components/contacts/contacts.module.css';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { When } from '@/components/ui/when';
import type { TaskDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';
import { todayIn, zonedToInstant } from '@/lib/time';

import styles from './activity.module.css';
import { FollowUpDialog } from './follow-up-dialog';

const RANGES = ['open', 'overdue', 'today', 'week', 'done', 'cancelled'] as const;
type Range = (typeof RANGES)[number];

/** End of the week (Sunday 23:59) and end of today in a time zone, as instants (C3-D7). */
export function dayBounds(timeZone: string, now = new Date()): { startOfToday: string; endOfToday: string; endOfWeek: string } {
  const today = todayIn(timeZone, now);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const toSunday = (7 - weekday) % 7;
  const sunday = new Date(`${today}T12:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() + toSunday);
  return {
    startOfToday: zonedToInstant(`${today}T00:00`, timeZone)!,
    endOfToday: zonedToInstant(`${today}T23:59`, timeZone)!,
    endOfWeek: zonedToInstant(`${sunday.toISOString().slice(0, 10)}T23:59`, timeZone)!,
  };
}

/**
 * F-2 follow-ups: Mine, or Team for managers (D6), by due time. Done,
 * Reschedule and Reassign act on one row; overdue rows say so in text.
 */
export function FollowUpsList() {
  const t = useTranslations('followUps');
  const list = useTranslations('list');
  const { can, session, readOnly } = useSession();
  const params = useListParams();
  const team = params.get('tab') === 'team' && can('lead.assign');
  const range: Range = RANGES.includes(params.get('range') as Range) ? (params.get('range') as Range) : 'open';
  const [composing, setComposing] = useState(params.get('compose') === '1');
  const [dialog, setDialog] = useState<{ kind: 'reschedule' | 'reassign' | 'cancel' | 'done'; task: TaskDto } | null>(null);

  const bounds = dayBounds(session.timezone);
  const query = new URLSearchParams();
  query.set('filter[view]', team ? 'team' : 'mine');
  query.set('sort', range === 'done' || range === 'cancelled' ? '-dueAt' : 'dueAt');
  if (range === 'done' || range === 'cancelled') query.set('filter[status]', range);
  else query.set('filter[status]', 'open');
  if (range === 'overdue') query.set('filter[overdue]', 'true');
  if (range === 'today') {
    query.set('filter[dueAt][gte]', bounds.startOfToday);
    query.set('filter[dueAt][lte]', bounds.endOfToday);
  }
  if (range === 'week') query.set('filter[dueAt][lte]', bounds.endOfWeek);
  const result = usePagedList<TaskDto>('tasks', query);

  const tabHref = (tab: 'mine' | 'team') => `/follow-ups?${new URLSearchParams({ ...(tab === 'team' ? { tab } : {}), ...(range !== 'open' ? { range } : {}) }).toString()}`;
  const rangeHref = (id: Range) => `/follow-ups?${new URLSearchParams({ ...(team ? { tab: 'team' } : {}), ...(id !== 'open' ? { range: id } : {}) }).toString()}`;
  const writable = !readOnly;

  const menu = (task: TaskDto): MenuAction[] => {
    if (task.status !== 'open' || !writable) return [];
    const actions: MenuAction[] = [];
    if (task.canEdit) actions.push({ id: 'reschedule', label: t('reschedule'), onAction: () => setDialog({ kind: 'reschedule', task }) });
    if (task.canReassign) actions.push({ id: 'reassign', label: t('reassign'), onAction: () => setDialog({ kind: 'reassign', task }) });
    if (task.canEdit) actions.push({ id: 'cancel', label: t('cancelTask'), onAction: () => setDialog({ kind: 'cancel', task }), danger: true });
    return actions;
  };

  return (
    <Page>
      <PageHeader
        title={t('title')}
        actions={
          writable ? (
            <Button variant="primary" onPress={() => setComposing(true)}>
              {t('new')}
            </Button>
          ) : undefined
        }
      />
      {can('lead.assign') ? (
        <nav aria-label={t('whose')} className={styles.tabs}>
          <NextLink href={tabHref('mine')} aria-current={!team ? 'page' : undefined} className={pillStyles.viewLink} scroll={false}>
            {t('mine')}
          </NextLink>
          <NextLink href={tabHref('team')} aria-current={team ? 'page' : undefined} className={pillStyles.viewLink} scroll={false}>
            {t('team')}
          </NextLink>
        </nav>
      ) : null}
      <nav aria-label={t('rangeLabel')} className={styles.tabs}>
        {RANGES.map((id) => (
          <NextLink key={id} href={rangeHref(id)} aria-current={range === id ? 'page' : undefined} className={pillStyles.viewLink} scroll={false}>
            {t(`range.${id}`)}
          </NextLink>
        ))}
      </nav>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true" aria-label={t('title')}>
          <Skeleton />
          <Skeleton />
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState title={t(`empty.${range}`)}>{t('emptyDetail')}</EmptyState>
      ) : (
        <DataTable
          caption={team ? t('captionTeam') : t('captionMine')}
          rows={result.rows}
          rowKey={(row) => row.id}
          sortNote={list('sortedBy', { sort: range === 'done' || range === 'cancelled' ? t('sortDueDesc') : t('sortDue') })}
          identifier={{
            header: t('what'),
            label: (row) => <bdi dir="auto">{row.title}</bdi>,
            secondary: (row) =>
              row.about ? (
                <NextLink href={`/${row.about.entityType === 'lead' ? 'leads' : 'contacts'}/${row.about.entityId}`}>
                  <bdi dir="auto">{row.about.label}</bdi>
                </NextLink>
              ) : null,
          }}
          status={{
            header: t('due'),
            cell: (row) => (
              <span className={styles.rowActions}>
                {row.dueAt ? <When iso={row.dueAt} /> : '—'}
                <OverdueMark overdue={row.overdue} />
                {row.reminderDue ? <StatusLabel tone="info">{t('reminderDue')}</StatusLabel> : null}
              </span>
            ),
          }}
          columns={[
            { key: 'assigned', header: t('assigned'), cell: (row) => <bdi>{row.assignedTo.name}</bdi>, onCard: team },
            { key: 'priority', header: t('priority'), cell: (row) => <PriorityLabel priority={row.priority} />, onCard: true },
            ...(range === 'cancelled' ? [{ key: 'reason', header: t('cancelReason'), cell: (row: TaskDto) => <bdi dir="auto">{row.cancelReason ?? '—'}</bdi> }] : []),
          ]}
          actionsHeader={t('actions')}
          actions={(row) => (
            <span className={styles.rowActions}>
              {row.status === 'open' && row.canEdit && writable ? (
                <Button size="small" onPress={() => setDialog({ kind: 'done', task: row })} aria-label={t('doneNamed', { title: row.title })}>
                  {t('done')}
                </Button>
              ) : null}
              <ActionsMenu label={t('moreFor', { title: row.title })} actions={menu(row)} />
            </span>
          )}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
      {composing ? (
        <FollowUpDialog
          onClose={() => {
            setComposing(false);
            if (params.get('compose') !== null) params.set({ compose: null });
          }}
        />
      ) : null}
      {dialog?.kind === 'reschedule' ? <FollowUpDialog task={dialog.task} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'done' ? <CompleteDialog task={dialog.task} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'cancel' ? <CancelDialog task={dialog.task} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'reassign' ? <ReassignDialog task={dialog.task} onClose={() => setDialog(null)} /> : null}
    </Page>
  );
}

/** Marks a follow-up done (with If-Match). */
export function CompleteDialog({ task, onClose }: { task: TaskDto; onClose: () => void }) {
  const t = useTranslations('followUps');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await bff(`tasks/${task.id}/complete`, { method: 'POST', version: task.version, body: {} });
      announce(t('completed', { title: task.title }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('doneTitle')}
      consequence={t('doneConsequence', { title: task.title })}
      confirmLabel={t('doneConfirm')}
      onConfirm={() => void submit()}
      busy={busy}
    >
      {error ? <FormProblem error={error} fields={{}} /> : null}
    </ConfirmDialog>
  );
}

function CancelDialog({ task, onClose }: { task: TaskDto; onClose: () => void }) {
  const t = useTranslations('followUps');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const submit = async () => {
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bff(`tasks/${task.id}/cancel`, { method: 'POST', version: task.version, body: { reason: reason.trim() } });
      announce(t('cancelled', { title: task.title }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('cancelTitle')}
      consequence={t('cancelConsequence', { title: task.title })}
      confirmLabel={t('cancelConfirm')}
      onConfirm={() => void submit()}
      busy={busy}
      danger
    >
      <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} />
      <TextField
        id={reasonId}
        label={common('reason')}
        value={reason}
        onChange={(value) => {
          setReason(value);
          setMissing(false);
        }}
        isRequired
        maxLength={500}
        dir="auto"
        error={missing ? common('reasonRequired') : fieldErrorsOf(error)['reason']}
      />
    </ConfirmDialog>
  );
}

/** Reassign (managers, D6): to a member who works the record's office. */
function ReassignDialog({ task, onClose }: { task: TaskDto; onClose: () => void }) {
  const t = useTranslations('followUps');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [assignee, setAssignee] = useState<PickedMember | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (assignee === null) {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bff(`tasks/${task.id}/assign`, { method: 'POST', version: task.version, body: { assignedTo: assignee.membershipId } });
      announce(t('reassigned', { title: task.title, name: assignee.displayName }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('reassignTitle')}
      consequence={t('reassignConsequence', { title: task.title, name: task.assignedTo.name })}
      confirmLabel={t('reassign')}
      onConfirm={() => void submit()}
      busy={busy}
    >
      {error ? <FormProblem error={error} fields={{}} /> : null}
      <PeoplePicker
        label={t('assignTo')}
        value={assignee}
        onChange={(member) => {
          setAssignee(member);
          setMissing(false);
        }}
        permission="contact.view"
        isRequired
        error={missing ? t('assigneeRequired') : fieldErrorsOf(error)['assignedTo']}
      />
      <Notice tone="info">{t('reassignHelp')}</Notice>
    </ConfirmDialog>
  );
}
