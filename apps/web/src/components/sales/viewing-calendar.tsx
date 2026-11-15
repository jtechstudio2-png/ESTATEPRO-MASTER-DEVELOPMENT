'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Ltr } from '@/components/crm/labels';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { Checkbox, SegmentedControl } from '@/components/ui/fields';
import { Page, PageHeader } from '@/components/ui/layout';
import { LoadMore } from '@/components/ui/list-controls';
import type { ViewingDto } from '@/lib/api-schema';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { instantToZoned, todayIn, zonedToInstant } from '@/lib/time';

import { ViewingStatusLabel, ZonedTime } from './sales-labels';
import styles from './sales.module.css';
import { addDays, calendarCells, shownOnCalendar, weekDays } from './sales-rules';
import { useNarrow } from './use-sales';
import { type BookingPreset, BookViewingDialog, OutcomeDialog, ViewingDrawer } from './viewing-dialogs';

function firstNames(viewing: ViewingDto): string {
  const names = viewing.attendees.map((attendee) => attendee.contact.name.split(' ')[0] ?? attendee.contact.name);
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

/**
 * V-1 viewing calendar: one's own week by default in the member's (office)
 * time zone; Team for office or all scope; a day view with one column per
 * agent; cancelled hidden unless asked (W-D3). Phones get the agenda for today
 * and tomorrow instead (XV-1, W-D4).
 */
export function ViewingCalendar() {
  const t = useTranslations('sales');
  const format = useFormat();
  const { session, can, grant, readOnly } = useSession();
  const params = useListParams();
  const narrow = useNarrow();
  const zone = session.timezone;
  const today = todayIn(zone);
  const scope = grant('viewing.view')?.scope;
  const team = scope !== 'own' && params.get('who') === 'team';
  const view = params.get('view') === 'day' ? 'day' : 'week';
  const offset = Number(params.get('week') ?? '0') || 0;
  const day = params.get('day') ?? today;
  const [showCancelled, setShowCancelled] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Quick create (SH-2) opens the booking dialog here.
  const [booking, setBooking] = useState<BookingPreset | null>(params.get('book') === '1' ? {} : null);
  const closeBooking = () => {
    setBooking(null);
    if (params.get('book') !== null) params.set({ book: null });
  };
  const [outcomeFor, setOutcomeFor] = useState<ViewingDto | null>(null);
  const canBook = can('viewing.manage') && !readOnly;

  const days = narrow ? [today, addDays(today, 1)] : view === 'day' ? [day] : weekDays(today, offset);
  const from = zonedToInstant(`${days[0]}T00:00`, zone) ?? new Date().toISOString();
  const to = zonedToInstant(`${addDays(days[days.length - 1]!, 1)}T00:00`, zone) ?? new Date().toISOString();
  const query = new URLSearchParams({ 'filter[scheduledStart][gte]': from, 'filter[scheduledStart][lte]': to, sort: 'scheduledStart' });
  if (!team || narrow) query.set('filter[agentMembershipId]', 'me');
  const result = usePagedList<ViewingDto>('viewings', query, { limit: 100 });
  const toLocal = (iso: string) => instantToZoned(iso, zone);
  const { cells, hours } = calendarCells(result.rows, days, toLocal, showCancelled);
  const otherZone = result.rows.some((viewing) => viewing.timezone !== zone);
  const dayLabel = (value: string) => new Intl.DateTimeFormat(format.locale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${value}T00:00:00Z`));
  const rangeLabel = days.length > 1 ? `${dayLabel(days[0]!)} – ${dayLabel(days[days.length - 1]!)}` : dayLabel(days[0]!);

  const eventButton = (viewing: ViewingDto) => (
    <button key={viewing.id} type="button" className={styles.event} data-status={viewing.status} onClick={() => setOpen(viewing.id)}>
      <span className="ep-num">
        {toLocal(viewing.scheduledStart).slice(11, 16)}–{toLocal(viewing.scheduledEnd).slice(11, 16)}
        {viewing.timezone !== zone ? (
          <>
            {' '}
            (<ZonedTime iso={viewing.scheduledStart} timeZone={viewing.timezone} />)
          </>
        ) : null}
      </span>
      <span>
        <Ltr>{viewing.listing.reference}</Ltr> <bdi dir="auto">{viewing.listing.title}</bdi>
      </span>
      <ViewingStatusLabel status={viewing.status} />
      {team ? <bdi className={styles.meta}>{viewing.agent.name}</bdi> : null}
      {viewing.attendees.length > 0 ? <bdi dir="auto">{firstNames(viewing)}</bdi> : null}
      {viewing.unitConflicts.length > 0 ? (
        <span>
          <span aria-hidden="true">⚠ </span>
          {t('sameUnit')}
        </span>
      ) : null}
    </button>
  );

  const header = (
    <PageHeader
      title={t('calendarTitle')}
      actions={
        canBook ? (
          <Button variant="primary" onPress={() => setBooking({})}>
            {t('bookViewing')}
          </Button>
        ) : undefined
      }
    />
  );

  if (narrow) {
    const agenda = days.map((value) => ({ day: value, rows: result.rows.filter((viewing) => toLocal(viewing.scheduledStart).slice(0, 10) === value && shownOnCalendar(viewing.status, false)) }));
    return (
      <Page>
        {header}
        <RefreshBar active={result.isFetching && !result.isPending} />
        {result.isPending ? (
          <Skeleton />
        ) : result.isError ? (
          <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
        ) : (
          <div className={styles.agenda}>
            {agenda.map((group) => (
              <section key={group.day} aria-labelledby={`agenda-${group.day}`}>
                <h2 className={styles.agendaDay} id={`agenda-${group.day}`}>
                  {group.day === today ? t('today') : t('tomorrow')} · {dayLabel(group.day)}
                </h2>
                {group.rows.length === 0 ? (
                  <p>{t('noViewingsDay')}</p>
                ) : (
                  <ul className={styles.list}>
                    {group.rows.map((viewing) => (
                      <li key={viewing.id}>
                        <span className={styles.itemMain}>{eventButton(viewing)}</span>
                        {viewing.canManage && !readOnly && viewing.needsOutcome ? (
                          <Button variant="primary" onPress={() => setOutcomeFor(viewing)}>
                            {t('recordOutcome')}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
        {open ? <ViewingDrawer id={open} onClose={() => setOpen(null)} onOpenViewing={setOpen} /> : null}
        {outcomeFor ? <OutcomeDialog viewing={outcomeFor} onClose={() => setOutcomeFor(null)} /> : null}
        {booking ? <BookViewingDialog preset={booking} onClose={closeBooking} /> : null}
      </Page>
    );
  }

  // Day view: one column per agent with a viewing that day (Team), or just "me".
  const agents = view === 'day' ? [...new Map(result.rows.filter((viewing) => shownOnCalendar(viewing.status, showCancelled)).map((viewing) => [viewing.agent.id, viewing.agent])).values()] : [];
  const columns: Array<{ key: string; label: string; day: string; agentId: string | null }> =
    view === 'day' && team && agents.length > 0
      ? agents.map((agent) => ({ key: agent.id, label: agent.name, day, agentId: agent.id }))
      : days.map((value) => ({ key: value, label: dayLabel(value), day: value, agentId: null }));

  return (
    <Page>
      {header}
      <div className={styles.actions} role="group" aria-label={t('calendarControls')}>
        {scope !== 'own' ? <SegmentedControl label={t('whose')} value={team ? 'team' : 'mine'} onChange={(value) => params.set({ who: value === 'team' ? 'team' : null })} options={[{ id: 'mine', label: t('mine') }, { id: 'team', label: t('team') }]} /> : null}
        <SegmentedControl label={t('calendarView')} value={view} onChange={(value) => params.set({ view: value === 'day' ? 'day' : null })} options={[{ id: 'week', label: t('week') }, { id: 'day', label: t('day') }]} />
        <span className={styles.inline}>
          <Button
            size="small"
            aria-label={view === 'day' ? t('previousDay') : t('previousWeek')}
            onPress={() => (view === 'day' ? params.set({ day: addDays(day, -1) }) : params.set({ week: String(offset - 1) }))}
          >
            <span aria-hidden="true">‹</span>
          </Button>
          <strong aria-live="polite">{rangeLabel}</strong>
          <Button size="small" aria-label={view === 'day' ? t('nextDay') : t('nextWeek')} onPress={() => (view === 'day' ? params.set({ day: addDays(day, 1) }) : params.set({ week: String(offset + 1) }))}>
            <span aria-hidden="true">›</span>
          </Button>
          <Button size="small" variant="quiet" onPress={() => params.set({ week: null, day: null })}>
            {t('today')}
          </Button>
        </span>
        <Checkbox isSelected={showCancelled} onChange={setShowCancelled}>
          {t('showCancelled')}
        </Checkbox>
      </div>
      <p className={styles.meta}>
        {t('timesIn', { zone })}
        {otherZone ? ` · ${t('otherZoneNote')}` : ''}
      </p>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <Skeleton />
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : (
        <>
          {result.rows.length === 0 ? (
            <EmptyState title={t('noViewingsRange')} headingLevel={2}>
              {canBook ? t('noViewingsRangeBook') : null}
            </EmptyState>
          ) : null}
          <div className={styles.calendarWrap}>
            <table className={styles.calendar}>
              <caption className="ep-visually-hidden">{t('calendarCaption', { range: rangeLabel })}</caption>
              <thead>
                <tr>
                  <td />
                  {columns.map((column) => (
                    <th key={column.key} scope="col" aria-current={column.agentId === null && column.day === today ? 'date' : undefined}>
                      <bdi>{column.label}</bdi>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {hours.map((hour) => {
                  const hh = String(hour).padStart(2, '0');
                  return (
                    <tr key={hour}>
                      <th scope="row" className="ep-num">
                        {hh}:00
                      </th>
                      {columns.map((column) => {
                        const events = (cells.get(`${column.day}|${hh}`) ?? []).filter((viewing) => column.agentId === null || viewing.agent.id === column.agentId);
                        return (
                          <td key={column.key} aria-current={column.agentId === null && column.day === today ? 'date' : undefined}>
                            <div className={styles.slot}>
                              {events.map(eventButton)}
                              {canBook && events.length === 0 ? (
                                <button type="button" tabIndex={-1} className={styles.emptySlot} aria-label={t('bookAt', { day: dayLabel(column.day), time: `${hh}:00` })} onClick={() => setBooking({ date: column.day, time: `${hh}:00` })} />
                              ) : null}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {result.hasNextPage ? <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} /> : null}
        </>
      )}
      {open ? <ViewingDrawer id={open} onClose={() => setOpen(null)} onOpenViewing={setOpen} /> : null}
      {booking ? <BookViewingDialog preset={booking} onClose={closeBooking} /> : null}
    </Page>
  );
}
