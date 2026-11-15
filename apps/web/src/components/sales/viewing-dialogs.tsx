'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { Ltr } from '@/components/crm/labels';
import { ContactSearch } from '@/components/leads/new-lead';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Checkbox, FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Facts } from '@/components/ui/layout';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { When } from '@/components/ui/when';
import type { ContactSummaryDto, KeySetPageDto, ListingListItemDto, ViewingDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { zonedToInstant } from '@/lib/time';

import { DealSearch, ListingSearch } from './record-search';
import { ViewingStatusLabel, ZonedTime } from './sales-labels';
import styles from './sales.module.css';
import { useAction, useViewing } from './use-sales';

const OUTCOMES = ['interested', 'not_interested', 'second_viewing', 'offer_expected', 'offer_made'] as const;
const TYPES = ['in_person', 'virtual', 'open_house'] as const;

export interface BookingPreset {
  listing?: { id: string; label: string } | null;
  lead?: { id: string; label: string } | null;
  deal?: { id: string; label: string } | null;
  attendees?: Array<{ id: string; name: string }>;
  /** Local date and time in the office time zone (a click on an empty calendar slot). */
  date?: string;
  time?: string;
}

function plusMinutes(time: string, minutes: number): string {
  const [hours, mins] = time.split(':').map(Number) as [number, number];
  const total = Math.min(hours * 60 + mins + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Whether the member may book for other agents (office or all scope). */
function useBooksForOthers(): boolean {
  const { grant } = useSession();
  const scope = grant('viewing.manage')?.scope;
  return scope === 'office' || scope === 'all';
}

/**
 * V-2 book a viewing, prefilled from where it started (calendar slot, listing,
 * lead or deal). Times are entered in the member's time zone and stored as
 * instants; V-3 shows them in the property's own zone.
 */
export function BookViewingDialog({ preset = {}, onClose, onBooked }: { preset?: BookingPreset; onClose: () => void; onBooked?: (viewing: ViewingDto) => void }) {
  const t = useTranslations('sales');
  const { session } = useSession();
  const forOthers = useBooksForOthers();
  const action = useAction();
  const [listing, setListing] = useState<{ id: string; label: string } | null>(preset.listing ?? null);
  const [forKind, setForKind] = useState<'lead' | 'deal' | 'none'>(preset.deal ? 'deal' : preset.lead ? 'lead' : 'none');
  const [deal, setDeal] = useState<{ id: string; label: string } | null>(preset.deal ?? null);
  const [viewingType, setViewingType] = useState<(typeof TYPES)[number]>('in_person');
  const [agent, setAgent] = useState<PickedMember | null>(null);
  const [date, setDate] = useState(preset.date ?? '');
  const [start, setStart] = useState(preset.time ?? '10:00');
  const [end, setEnd] = useState(plusMinutes(preset.time ?? '10:00', 30));
  const [attendees, setAttendees] = useState<Array<{ id: string; name: string }>>(preset.attendees ?? []);
  const [adding, setAdding] = useState<ContactSummaryDto | null>(null);
  const [meetingPoint, setMeetingPoint] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const ids = { listing: useId(), date: useId(), start: useId(), end: useId(), deal: useId(), attendee: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const fieldError = (key: string) => clientErrors[key] ?? serverErrors[key];

  const submit = () => {
    const errors: Record<string, string> = {};
    if (listing === null) errors['listingId'] = t('listingRequired');
    const scheduledStart = date ? zonedToInstant(`${date}T${start}`, session.timezone) : null;
    const scheduledEnd = date ? zonedToInstant(`${date}T${end}`, session.timezone) : null;
    if (scheduledStart === null) errors['scheduledStart'] = t('dateRequired');
    else if (scheduledEnd === null || scheduledEnd <= scheduledStart) errors['scheduledEnd'] = t('endAfterStart');
    if (forKind === 'deal' && deal === null) errors['dealId'] = t('dealRequired');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void action.run(
      () =>
        bff<ViewingDto>('viewings', {
          method: 'POST',
          body: {
            listingId: listing!.id,
            viewingType,
            scheduledStart: scheduledStart!,
            scheduledEnd: scheduledEnd!,
            confirmed,
            ...(agent ? { agentMembershipId: agent.membershipId } : {}),
            ...(attendees.length > 0 ? { attendeeContactIds: attendees.map((attendee) => attendee.id) } : {}),
            ...(forKind === 'lead' && preset.lead ? { leadId: preset.lead.id } : {}),
            ...(forKind === 'deal' && deal ? { dealId: deal.id } : {}),
            ...(meetingPoint.trim() ? { meetingPoint: meetingPoint.trim() } : {}),
          },
        }),
      t('viewingBooked'),
      (viewing) => {
        onClose();
        onBooked?.(viewing);
      },
    );
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('bookViewing')} consequence={t('bookConsequence')} confirmLabel={t('book')} onConfirm={submit} busy={action.busy}>
      <FormProblem
        error={action.error}
        clientErrors={clientErrors}
        fields={{
          listingId: { label: t('listing'), id: ids.listing },
          dealId: { label: t('deal'), id: ids.deal },
          scheduledStart: { label: t('date'), id: ids.date },
          scheduledEnd: { label: t('endTime'), id: ids.end },
          attendeeContactIds: { label: t('attendees'), id: ids.attendee },
        }}
      />
      {preset.listing ? (
        <p>
          {t('listing')}: <bdi dir="auto">{preset.listing.label}</bdi>
        </p>
      ) : (
        <ListingSearch
          label={t('listing')}
          help={t('liveListingsOnly')}
          value={listing}
          onChange={(item: ListingListItemDto | null) => setListing(item ? { id: item.id, label: `${item.reference} ${item.title}` } : null)}
          labelId={ids.listing}
          isRequired
          error={fieldError('listingId')}
        />
      )}
      <RadioGroupField
        label={t('bookingFor')}
        value={forKind}
        onChange={(value) => setForKind(value as 'lead' | 'deal' | 'none')}
        options={[
          ...(preset.lead ? [{ id: 'lead', label: t('forLead', { reference: preset.lead.label }) }] : []),
          { id: 'deal', label: t('forDeal') },
          { id: 'none', label: t('forNone') },
        ]}
      />
      {forKind === 'deal' ? (
        preset.deal ? (
          <p>
            <Ltr>{preset.deal.label}</Ltr>
          </p>
        ) : (
          <DealSearch label={t('deal')} value={deal} onChange={(item) => setDeal(item ? { id: item.id, label: item.reference } : null)} labelId={ids.deal} isRequired error={fieldError('dealId')} />
        )
      ) : null}
      <FieldRow>
        <SelectField label={t('viewingType')} value={viewingType} onChange={(value) => setViewingType(value as (typeof TYPES)[number])} options={TYPES.map((id) => ({ id, label: t(`viewingTypeName.${id}`) }))} />
        {forOthers ? <PeoplePicker label={t('agent')} value={agent} onChange={setAgent} permission="viewing.manage" description={t('agentDefaultYou')} error={fieldError('agentMembershipId')} /> : null}
      </FieldRow>
      <FieldRow>
        <TextField id={ids.date} label={t('date')} type="date" value={date} onChange={setDate} isRequired error={fieldError('scheduledStart')} />
        <TextField
          id={ids.start}
          label={t('startTime')}
          type="time"
          value={start}
          onChange={(value) => {
            setStart(value);
            if (value) setEnd(plusMinutes(value, 30));
          }}
          isRequired
        />
        <TextField id={ids.end} label={t('endTime')} type="time" value={end} onChange={setEnd} isRequired error={fieldError('scheduledEnd')} />
      </FieldRow>
      <p className={styles.meta}>{t('inTimeZone', { zone: session.timezone })}</p>
      <fieldset>
        <legend>{t('attendees')}</legend>
        {attendees.length > 0 ? (
          <ul className={styles.list}>
            {attendees.map((attendee) => (
              <li key={attendee.id}>
                <bdi dir="auto">{attendee.name}</bdi>
                <Button size="small" variant="quiet" onPress={() => setAttendees((current) => current.filter((item) => item.id !== attendee.id))} aria-label={t('removeAttendee', { name: attendee.name })}>
                  {t('remove')}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <ContactSearch
          key={attendees.length}
          value={adding}
          onChange={(contact) => {
            setAdding(null);
            if (contact && !attendees.some((attendee) => attendee.id === contact.id)) setAttendees((current) => [...current, { id: contact.id, name: contact.displayName }]);
          }}
          labelId={ids.attendee}
          label={t('addAttendee')}
          help={t('attendeeHelp')}
          error={fieldError('attendeeContactIds')}
        />
      </fieldset>
      <TextField label={t('meetingPoint')} value={meetingPoint} onChange={setMeetingPoint} maxLength={500} dir="auto" description={t('noIdNumbers')} />
      <Checkbox isSelected={confirmed} onChange={setConfirmed}>
        {t('alreadyConfirmed')}
      </Checkbox>
      <Notice tone="info">{t('bookingEffects')}</Notice>
    </ConfirmDialog>
  );
}

type Sub = 'reschedule' | 'cancel' | 'outcome' | 'noShow' | 'keys' | null;

/**
 * V-3 viewing details as a drawer: facts, attendees and the actions the API
 * allows (`canManage`). Finished viewings are read only, except feedback
 * sharing after an outcome (P6-D3).
 */
export function ViewingDrawer({ id, onClose, onOpenViewing }: { id: string; onClose: () => void; onOpenViewing?: (id: string) => void }) {
  const t = useTranslations('sales');
  const { can, readOnly } = useSession();
  const viewing = useViewing(id);
  const action = useAction();
  const [sub, setSub] = useState<Sub>(null);
  const record = viewing.data;
  const live = record !== undefined && (record.status === 'scheduled' || record.status === 'confirmed');
  const started = record !== undefined && new Date(record.scheduledStart).getTime() <= Date.now();
  const manage = record !== undefined && record.canManage && !readOnly;

  return (
    <Dialog
      isOpen
      drawer
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={record ? <ZonedTime iso={record.scheduledStart} end={record.scheduledEnd} timeZone={record.timezone} /> : t('viewing')}
      footer={
        record && manage ? (
          <span className={styles.actions}>
            {live && record.status === 'scheduled' && !started ? (
              <Button onPress={() => void action.run(() => bff(`viewings/${record.id}/confirm`, { method: 'POST', version: record.version }), t('viewingConfirmed'))} busy={action.busy}>
                {t('confirm')}
              </Button>
            ) : null}
            {live && !started ? <Button onPress={() => setSub('reschedule')}>{t('reschedule')}</Button> : null}
            {live ? (
              <Button variant="quiet" onPress={() => setSub('cancel')}>
                {t('cancelViewing')}
              </Button>
            ) : null}
            {live && started ? (
              <Button variant="primary" onPress={() => setSub('outcome')}>
                {t('recordOutcome')}
              </Button>
            ) : null}
            {live && started ? <Button onPress={() => setSub('noShow')}>{t('noShow')}</Button> : null}
          </span>
        ) : undefined
      }
    >
      {viewing.isPending ? (
        <Skeleton />
      ) : viewing.isError ? (
        <ErrorNotice error={viewing.error} onRetry={() => void viewing.refetch()} />
      ) : record ? (
        <>
          <FormProblem error={action.error} fields={{}} />
          <p className={styles.inline}>
            <ViewingStatusLabel status={record.status} />
            <span>{t(`viewingTypeName.${record.viewingType}`)}</span>
            <span>{t('agentNamed', { name: record.agent.name })}</span>
          </p>
          {record.unitConflicts.length > 0 ? (
            <Notice tone="warning" title={t('unitClash', { count: record.unitConflicts.length })}>
              <ul>
                {record.unitConflicts.map((conflict) => (
                  <li key={conflict.id}>
                    <ZonedTime iso={conflict.scheduledStart} end={conflict.scheduledEnd} timeZone={record.timezone} />
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <Facts
            items={[
              {
                label: t('listing'),
                value: (
                  <NextLink href={`/listings/${record.listing.id}`}>
                    <Ltr>{record.listing.reference}</Ltr> <bdi dir="auto">{record.listing.title}</bdi>
                  </NextLink>
                ),
              },
              { label: t('place'), value: <bdi dir="auto">{`${record.place.propertyName} · ${record.place.unitLabel}`}</bdi> },
              record.lead ? { label: t('lead'), value: <NextLink href={`/leads/${record.lead.id}`}><Ltr>{record.lead.reference}</Ltr></NextLink> } : null,
              record.deal ? { label: t('deal'), value: <NextLink href={`/deals/${record.deal.id}`}><Ltr>{record.deal.reference}</Ltr></NextLink> } : null,
              record.meetingPoint ? { label: t('meetingPoint'), value: <bdi dir="auto">{record.meetingPoint}</bdi> } : null,
              record.outcome ? { label: t('outcome'), value: t(`outcomeName.${record.outcome}`) } : null,
              record.cancelledReason ? { label: t('cancelReason'), value: <bdi dir="auto">{record.cancelledReason}</bdi> } : null,
            ]}
          />
          <h3>{t('attendees')}</h3>
          {record.attendees.length === 0 ? (
            <p>{t('noAttendees')}</p>
          ) : (
            <ul className={styles.list}>
              {record.attendees.map((attendee) => (
                <li key={attendee.contact.id}>
                  <NextLink href={`/contacts/${attendee.contact.id}`}>
                    <bdi dir="auto">{attendee.contact.name}</bdi>
                  </NextLink>
                  <span>{t(`attendance.${attendee.attendance}`)}</span>
                </li>
              ))}
            </ul>
          )}
          {record.feedback !== null ? (
            <>
              <h3>{t('feedback')}</h3>
              <p className={styles.body} dir="auto">
                {record.feedback}
              </p>
              <p>{record.feedbackShared ? t('feedbackShared') : t('feedbackNotShared')}</p>
              {manage && record.status === 'completed' ? (
                <Button
                  size="small"
                  onPress={() => void action.run(() => bff(`viewings/${record.id}/feedback-sharing`, { method: 'POST', version: record.version, body: { shared: !record.feedbackShared } }), record.feedbackShared ? t('feedbackUnshared') : t('feedbackNowShared'))}
                  busy={action.busy}
                >
                  {record.feedbackShared ? t('stopSharing') : t('shareFeedback')}
                </Button>
              ) : null}
            </>
          ) : null}
          {live && can('key.issue') && !readOnly ? (
            <p>
              <Button size="small" onPress={() => setSub('keys')}>
                {t('checkOutKeys')}
              </Button>
            </p>
          ) : null}
          <p className={styles.meta}>
            {record.createdBy ? t('bookedBy', { name: record.createdBy.name }) : t('booked')} · <When iso={record.createdAt} />
            {record.rescheduledFromId ? (
              <>
                {' · '}
                <Button size="small" variant="quiet" onPress={() => onOpenViewing?.(record.rescheduledFromId!)}>
                  {t('rescheduledFrom')}
                </Button>
              </>
            ) : null}
            {record.rescheduledToId ? (
              <>
                {' · '}
                <Button size="small" variant="quiet" onPress={() => onOpenViewing?.(record.rescheduledToId!)}>
                  {t('rescheduledTo')}
                </Button>
              </>
            ) : null}
          </p>
          {sub === 'reschedule' ? <RescheduleDialog viewing={record} onClose={() => setSub(null)} onDone={(next) => onOpenViewing?.(next.id)} /> : null}
          {sub === 'cancel' ? <CancelViewingDialog viewing={record} onClose={() => setSub(null)} /> : null}
          {sub === 'outcome' ? <OutcomeDialog viewing={record} onClose={() => setSub(null)} /> : null}
          {sub === 'noShow' ? <NoShowDialog viewing={record} onClose={() => setSub(null)} /> : null}
          {sub === 'keys' ? <KeyCheckOutDialog viewing={record} onClose={() => setSub(null)} /> : null}
        </>
      ) : null}
    </Dialog>
  );
}

function RescheduleDialog({ viewing, onClose, onDone }: { viewing: ViewingDto; onClose: () => void; onDone: (next: ViewingDto) => void }) {
  const t = useTranslations('sales');
  const { session } = useSession();
  const action = useAction();
  const [date, setDate] = useState('');
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('10:30');
  const [reason, setReason] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const ids = { date: useId(), end: useId() };
  const submit = () => {
    const scheduledStart = date ? zonedToInstant(`${date}T${start}`, session.timezone) : null;
    const scheduledEnd = date ? zonedToInstant(`${date}T${end}`, session.timezone) : null;
    const errors: Record<string, string> = {};
    if (scheduledStart === null) errors['scheduledStart'] = t('dateRequired');
    else if (scheduledEnd === null || scheduledEnd <= scheduledStart) errors['scheduledEnd'] = t('endAfterStart');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void action.run(
      () => bff<ViewingDto>(`viewings/${viewing.id}/reschedule`, { method: 'POST', version: viewing.version, body: { scheduledStart: scheduledStart!, scheduledEnd: scheduledEnd!, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
      t('viewingRescheduled'),
      (next) => {
        onClose();
        onDone(next);
      },
    );
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('rescheduleTitle')} consequence={t('rescheduleConsequence')} confirmLabel={t('reschedule')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} clientErrors={clientErrors} fields={{ scheduledStart: { label: t('date'), id: ids.date }, scheduledEnd: { label: t('endTime'), id: ids.end } }} />
      <FieldRow>
        <TextField id={ids.date} label={t('date')} type="date" value={date} onChange={setDate} isRequired error={clientErrors['scheduledStart']} />
        <TextField label={t('startTime')} type="time" value={start} onChange={(value) => {
          setStart(value);
          if (value) setEnd(plusMinutes(value, 30));
        }} isRequired />
        <TextField id={ids.end} label={t('endTime')} type="time" value={end} onChange={setEnd} isRequired error={clientErrors['scheduledEnd']} />
      </FieldRow>
      <p className={styles.meta}>{t('inTimeZone', { zone: session.timezone })}</p>
      <TextField label={t('reason')} value={reason} onChange={setReason} maxLength={500} dir="auto" description={t('noIdNumbers')} />
    </ConfirmDialog>
  );
}

function CancelViewingDialog({ viewing, onClose }: { viewing: ViewingDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const ids = { reason: useId() };
  const submit = () => {
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    void action.run(() => bff(`viewings/${viewing.id}/cancel`, { method: 'POST', version: viewing.version, body: { reason: reason.trim() } }), t('viewingCancelled'), onClose);
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('cancelViewingTitle')} consequence={t('cancelViewingConsequence')} confirmLabel={t('cancelViewing')} onConfirm={submit} busy={action.busy} danger>
      <FormProblem error={action.error} clientErrors={missing ? { reason: t('reasonRequired') } : {}} fields={{ reason: { label: t('reason'), id: ids.reason } }} />
      <TextField id={ids.reason} label={t('reason')} value={reason} onChange={setReason} multiline maxLength={500} dir="auto" isRequired description={t('noIdNumbers')} error={missing ? t('reasonRequired') : undefined} />
    </ConfirmDialog>
  );
}

/** V-4 outcome: final once saved (P6-D3); sharing with the landlord is off by default. */
export function OutcomeDialog({ viewing, onClose }: { viewing: ViewingDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const [outcome, setOutcome] = useState<string>('');
  const [feedback, setFeedback] = useState('');
  const [share, setShare] = useState(false);
  const [attended, setAttended] = useState<Record<string, boolean>>(() => Object.fromEntries(viewing.attendees.map((attendee) => [attendee.contact.id, attendee.attendance !== 'absent'])));
  const [missing, setMissing] = useState(false);
  const [noShow, setNoShow] = useState(false);
  const ids = { outcome: useId() };
  const submit = () => {
    if (outcome === '') {
      setMissing(true);
      return;
    }
    void action.run(
      () =>
        bff(`viewings/${viewing.id}/outcome`, {
          method: 'POST',
          version: viewing.version,
          body: {
            outcome,
            shareFeedback: share,
            ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
            ...(viewing.attendees.length > 0 ? { attendance: viewing.attendees.map((attendee) => ({ contactId: attendee.contact.id, attendance: attended[attendee.contact.id] ? 'attended' : 'absent' })) } : {}),
          },
        }),
      t('outcomeSaved'),
      onClose,
    );
  };
  if (noShow) return <NoShowDialog viewing={viewing} onClose={onClose} />;
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('outcomeTitle')} consequence={t('outcomeFinal')} confirmLabel={t('save')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} clientErrors={missing ? { outcome: t('outcomeRequired') } : {}} fields={{ outcome: { label: t('outcome'), id: ids.outcome } }} />
      <RadioGroupField
        label={t('outcome')}
        value={outcome}
        onChange={(value) => {
          setOutcome(value);
          setMissing(false);
        }}
        options={OUTCOMES.map((id) => ({ id, label: t(`outcomeName.${id}`) }))}
        isRequired
        error={missing ? t('outcomeRequired') : undefined}
      />
      {viewing.attendees.length > 0 ? (
        <fieldset>
          <legend>{t('attended')}</legend>
          {viewing.attendees.map((attendee) => (
            <Checkbox key={attendee.contact.id} isSelected={attended[attendee.contact.id] ?? true} onChange={(value) => setAttended((current) => ({ ...current, [attendee.contact.id]: value }))}>
              <bdi dir="auto">{attendee.contact.name}</bdi>
            </Checkbox>
          ))}
        </fieldset>
      ) : null}
      <TextField label={t('feedback')} value={feedback} onChange={setFeedback} multiline maxLength={4000} dir="auto" description={t('noIdNumbers')} />
      <Checkbox isSelected={share} onChange={setShare}>
        {t('shareWithLandlord')}
      </Checkbox>
      <p>
        <Button variant="quiet" onPress={() => setNoShow(true)}>
          {t('nobodyCame')}
        </Button>
      </p>
    </ConfirmDialog>
  );
}

function NoShowDialog({ viewing, onClose }: { viewing: ViewingDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const [note, setNote] = useState('');
  const submit = () => void action.run(() => bff(`viewings/${viewing.id}/no-show`, { method: 'POST', version: viewing.version, body: note.trim() ? { note: note.trim() } : {} }), t('noShowSaved'), onClose);
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('noShowTitle')} consequence={t('noShowConsequence')} confirmLabel={t('noShow')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} fields={{}} />
      <TextField label={t('note')} value={note} onChange={setNote} multiline maxLength={2000} dir="auto" description={t('noIdNumbers')} />
    </ConfirmDialog>
  );
}

/** Keys for this viewing (S1-D10): to the agent or an attendee, due back an hour after by default. */
function KeyCheckOutDialog({ viewing, onClose }: { viewing: ViewingDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const keys = useQuery({ queryKey: ['list', 'viewing-keys', viewing.place.propertyId], queryFn: () => bff<KeySetPageDto>(`key-sets?filter[propertyId]=${viewing.place.propertyId}&filter[status]=in_office&limit=50`) });
  const usable = (keys.data?.data ?? []).filter((key) => key.unitId === null || key.unitId === viewing.place.unitId);
  const [keySetId, setKeySetId] = useState('');
  const [holder, setHolder] = useState('agent');
  const chosen = keySetId || usable[0]?.id || '';
  const submit = () =>
    void action.run(() => bff(`viewings/${viewing.id}/keys/check-out`, { method: 'POST', body: { keySetId: chosen, ...(holder !== 'agent' ? { contactId: holder } : {}) } }), t('keysCheckedOut'), onClose);
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('checkOutKeys')} consequence={t('keysConsequence')} confirmLabel={t('checkOut')} onConfirm={submit} busy={action.busy} canConfirm={chosen !== ''}>
      <FormProblem error={action.error} fields={{}} />
      {keys.isPending ? (
        <Skeleton />
      ) : usable.length === 0 ? (
        <p>{t('noKeysInOffice')}</p>
      ) : (
        <>
          <SelectField label={t('keySet')} value={chosen} onChange={setKeySetId} options={usable.map((key) => ({ id: key.id, label: key.unitLabel ? `${key.label} · ${key.unitLabel}` : key.label }))} />
          <SelectField
            label={t('keyHolder')}
            value={holder}
            onChange={setHolder}
            options={[{ id: 'agent', label: t('keyToAgent', { name: viewing.agent.name }) }, ...viewing.attendees.map((attendee) => ({ id: attendee.contact.id, label: attendee.contact.name }))]}
          />
        </>
      )}
    </ConfirmDialog>
  );
}
