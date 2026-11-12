'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Panel } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { When } from '@/components/ui/when';
import type { ActivityDetailDto, ActivityDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';
import { todayIn } from '@/lib/time';

import { ActivityLinks, ActivityTypeLabel, durationMinutes, useOutcomeLabel } from './activity-labels';
import styles from './activity.module.css';
import { type LinkedRecord, LogActivityDialog } from './log-activity';
import { FollowUpDialog } from './follow-up-dialog';

/** Type filters of A-1; "messages" covers WhatsApp, SMS and email. */
const FILTERS = {
  all: null,
  calls: 'call',
  messages: 'whatsapp,sms,email',
  meetings: 'meeting',
  notes: 'note',
  system: 'status_change,system,portal,document',
} as const;
type Filter = keyof typeof FILTERS;

interface TimelineProps {
  about: { entityType: 'contact' | 'lead'; entityId: string; label: string };
  /** Other records a new entry is linked to (a lead's contact). */
  extraLinks?: LinkedRecord[];
  /** May the member log here (write access to the record, C3-D4). */
  canLog: boolean;
  /** Overview panels show the latest few with "See all". */
  limit?: number;
  seeAllHref?: string;
}

/**
 * A-1 activity timeline: one history across roles and leads, newest first,
 * grouped by day, as an ordered list. Same-time entries keep a stable order
 * (#15). System entries cannot be edited; entries are archived, never deleted.
 */
export function ActivityTimeline({ about, extraLinks = [], canLog, limit, seeAllHref }: TimelineProps) {
  const t = useTranslations('activity');
  const { session } = useSession();
  const format = useFormat();
  const outcomeLabel = useOutcomeLabel();
  const [filter, setFilter] = useState<Filter>('all');
  const [archived, setArchived] = useState(false);
  const [logging, setLogging] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [editing, setEditing] = useState<ActivityDto | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'archive' | 'history'; activity: ActivityDto } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const headingId = useId();

  const query = new URLSearchParams();
  if (FILTERS[filter]) query.set('filter[activityType]', FILTERS[filter]);
  if (archived) query.set('filter[archived]', 'all');
  const path = about.entityType === 'contact' ? `contacts/${about.entityId}/activities` : `leads/${about.entityId}/activities`;
  const result = usePagedList<ActivityDto>(path, query, { limit: limit ?? 25 });
  const rows = limit ? result.rows.slice(0, limit) : result.rows;

  // "Load older" moves focus to the first new entry (wireframes §10).
  const shownBefore = useRef(0);
  const loadOlder = () => {
    shownBefore.current = result.rows.length;
    result.loadMore();
  };
  useEffect(() => {
    if (shownBefore.current > 0 && result.rows.length > shownBefore.current) {
      const item = listRef.current?.querySelectorAll<HTMLElement>('li[data-entry]')[shownBefore.current];
      item?.focus();
      shownBefore.current = 0;
    }
  }, [result.rows.length]);

  const today = todayIn(session.timezone);
  const yesterday = todayIn(session.timezone, new Date(Date.now() - 86_400_000));
  const dayOf = (iso: string) => todayIn(session.timezone, new Date(iso));
  const dayLabel = (day: string) => (day === today ? t('today') : day === yesterday ? t('yesterday') : format.date(day));

  const menu = (activity: ActivityDto): MenuAction[] => {
    const actions: MenuAction[] = [];
    if (activity.canEdit) actions.push({ id: 'edit', label: t('edit'), onAction: () => setEditing(activity) });
    if (activity.editedAt) actions.push({ id: 'history', label: t('history'), onAction: () => setDialog({ kind: 'history', activity }) });
    if (activity.canArchive && activity.archivedAt === null) actions.push({ id: 'archive', label: t('archive'), onAction: () => setDialog({ kind: 'archive', activity }), danger: true });
    return actions;
  };

  const links: LinkedRecord[] = [{ entityType: about.entityType, entityId: about.entityId, label: about.label }, ...extraLinks];
  let lastDay = '';
  return (
    <Panel
      title={limit ? t('recentTitle') : t('title')}
      actions={
        <>
          {canLog ? (
            <Button variant="primary" onPress={() => setLogging(true)}>
              {t('log')}
            </Button>
          ) : null}
          {seeAllHref ? <LinkButton href={seeAllHref}>{t('seeAll')}</LinkButton> : null}
        </>
      }
    >
      {!limit ? (
        <div className={styles.filters} role="group" aria-label={t('filterLabel')}>
          {(Object.keys(FILTERS) as Filter[]).map((id) => (
            <Button key={id} size="small" variant={filter === id ? 'primary' : 'secondary'} aria-pressed={filter === id} onPress={() => setFilter(id)}>
              {t(`filter.${id}`)}
            </Button>
          ))}
          <Button size="small" variant={archived ? 'primary' : 'secondary'} aria-pressed={archived} onPress={() => setArchived(!archived)}>
            {t('showArchived')}
          </Button>
        </div>
      ) : null}
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true" aria-label={t('title')}>
          <Skeleton />
          <Skeleton />
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={filter === 'all' ? t('emptyTitle') : t('emptyFiltered')} headingLevel={3}>
          {t('emptyDetail')}
        </EmptyState>
      ) : (
        <>
          <h3 id={headingId} className="ep-visually-hidden">
            {t('entries')}
          </h3>
          <ol ref={listRef} className={styles.timeline} aria-labelledby={headingId}>
            {rows.map((activity) => {
              const day = dayOf(activity.occurredAt);
              const heading = day !== lastDay ? dayLabel(day) : null;
              lastDay = day;
              const minutes = durationMinutes(activity.durationSeconds);
              const outcome = outcomeLabel(activity.outcomeCode);
              return (
                <li key={activity.id} data-entry tabIndex={-1} className={styles.entry}>
                  {heading ? <p className={styles.day}>{heading}</p> : null}
                  <div className={styles.entryRow}>
                    <div className={styles.entryMain}>
                      <p className={styles.entryHead}>
                        <ActivityTypeLabel type={activity.activityType} />
                        <span aria-hidden="true">·</span>
                        <time dateTime={activity.occurredAt} className="ep-num">
                          {format.dateTime(activity.occurredAt)}
                        </time>
                        {activity.direction && activity.direction !== 'internal' ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{t(`directionValue.${activity.direction}`)}</span>
                          </>
                        ) : null}
                        {minutes !== null ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{t('minutes', { count: minutes })}</span>
                          </>
                        ) : null}
                        {activity.performedBy ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <bdi>{activity.performedBy.name}</bdi>
                          </>
                        ) : null}
                        {activity.createdBy && activity.performedBy && activity.createdBy.id !== activity.performedBy.id ? (
                          <span className={styles.meta}>{t('loggedBy', { name: activity.createdBy.name })}</span>
                        ) : null}
                      </p>
                      {activity.subject ? (
                        <p className={styles.subject} dir="auto">
                          {activity.subject}
                        </p>
                      ) : null}
                      {outcome ? <p>{t('outcomeLine', { outcome })}</p> : null}
                      {activity.body ? (
                        <p className={styles.body} dir="auto">
                          {activity.body}
                        </p>
                      ) : null}
                      <p className={styles.meta}>
                        <ActivityLinks links={activity.links} exclude={about.entityId} />
                        {activity.editedAt ? <span> {t('editedMark')}</span> : null}
                      </p>
                      {activity.archivedAt ? (
                        <p className={styles.meta}>{t.rich('archivedOn', { when: () => <When iso={activity.archivedAt!} />, reason: activity.archivedReason ?? '' })}</p>
                      ) : null}
                    </div>
                    <ActionsMenu label={t('actionsFor', { type: t(`type.${activity.activityType}`), when: format.dateTime(activity.occurredAt) })} actions={menu(activity)} />
                  </div>
                </li>
              );
            })}
          </ol>
          {!limit && result.hasNextPage ? (
            <Button onPress={loadOlder} busy={result.isFetchingNextPage}>
              {t('loadOlder')}
            </Button>
          ) : null}
        </>
      )}
      {logging ? <LogActivityDialog links={links} onClose={() => setLogging(false)} onScheduleFollowUp={() => setFollowUp(true)} /> : null}
      {followUp ? <FollowUpDialog about={{ entityType: about.entityType, entityId: about.entityId, label: about.label }} onClose={() => setFollowUp(false)} /> : null}
      {editing ? <LogActivityDialog links={links} activity={editing} onClose={() => setEditing(null)} /> : null}
      {dialog?.kind === 'archive' ? <ArchiveActivityDialog activity={dialog.activity} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'history' ? <HistoryDialog activity={dialog.activity} onClose={() => setDialog(null)} /> : null}
    </Panel>
  );
}

/** Archive with a reason (D5): entries are never deleted. */
function ArchiveActivityDialog({ activity, onClose }: { activity: ActivityDto; onClose: () => void }) {
  const t = useTranslations('activity');
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
      await bff(`activities/${activity.id}/archive`, { method: 'POST', version: activity.version, body: { reason: reason.trim() } });
      announce(t('archived'));
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
      title={t('archiveTitle')}
      consequence={t('archiveConsequence')}
      confirmLabel={t('archiveConfirm')}
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

/** Earlier versions of an edited entry (D5 keeps them). */
function HistoryDialog({ activity, onClose }: { activity: ActivityDto; onClose: () => void }) {
  const t = useTranslations('activity');
  const format = useFormat();
  const detail = useQuery({ queryKey: ['record', 'activity', activity.id], queryFn: () => bff<ActivityDetailDto>(`activities/${activity.id}`) });
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('historyTitle')} drawer>
      {detail.isPending ? (
        <Skeleton />
      ) : detail.isError ? (
        <ErrorNotice error={detail.error} />
      ) : (
        <ol className={styles.timeline}>
          <li className={styles.entry}>
            <p className={styles.entryHead}>{t('currentVersion')}</p>
            {detail.data.subject ? <p dir="auto">{detail.data.subject}</p> : null}
            <p className={styles.body} dir="auto">
              {detail.data.body ?? '—'}
            </p>
          </li>
          {[...detail.data.revisions].reverse().map((revision) => (
            <li key={revision.revisionNo} className={styles.entry}>
              <p className={styles.entryHead}>
                {t('revision', { number: revision.revisionNo })} · {format.dateTime(revision.editedAt)}
                {revision.editedBy ? <> · <bdi>{revision.editedBy.name}</bdi></> : null}
              </p>
              {revision.subject ? <p dir="auto">{revision.subject}</p> : null}
              <p className={styles.body} dir="auto">
                {revision.body ?? '—'}
              </p>
            </li>
          ))}
        </ol>
      )}
      {detail.data && detail.data.revisions.length === 0 ? <Notice tone="info">{t('noRevisions')}</Notice> : null}
    </Dialog>
  );
}
