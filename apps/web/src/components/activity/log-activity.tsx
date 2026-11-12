'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Checkbox, FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass } from '@/components/ui/layout';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import type { ActivityDetailDto, ActivityDto, ActivityLinkInput, EditActivityBody, LogActivityBody } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { usePicklist } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';
import { instantToZoned, zonedToInstant } from '@/lib/time';

import { LOGGABLE_TYPES, type LoggableType } from './activity-labels';

export interface LinkedRecord extends ActivityLinkInput {
  label: string;
}

interface LogActivityProps {
  /** Records the entry is about (A-2 "Linked to"); a lead's entry is also linked to its contact by the API. */
  links: LinkedRecord[];
  initialType?: LoggableType;
  initialDirection?: 'inbound' | 'outbound';
  /** Editing an existing entry within its edit window (D5); its type and links stay. */
  activity?: ActivityDto;
  onClose: () => void;
  /** Called after saving when the user asked to schedule a follow-up. */
  onScheduleFollowUp?: () => void;
}

/**
 * A-2 log activity (and edit within 24 hours, decision D5). Phase 5 records
 * communications; it never sends them (CRM-10 is Phase 12). The first
 * outbound call, message or any meeting on a lead sets its first response on
 * the server (C3-D2).
 */
export function LogActivityDialog({ links, initialType = 'call', initialDirection = 'outbound', activity, onClose, onScheduleFollowUp }: LogActivityProps) {
  const t = useTranslations('activity');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { session } = useSession();
  const outcomes = usePicklist('activity_outcome');
  const editing = activity !== undefined;
  const [type, setType] = useState<LoggableType>((activity?.activityType as LoggableType | undefined) ?? initialType);
  const [direction, setDirection] = useState<'inbound' | 'outbound'>(activity?.direction === 'inbound' ? 'inbound' : activity?.direction === 'outbound' ? 'outbound' : initialDirection);
  const [when, setWhen] = useState(() => instantToZoned(activity?.occurredAt ?? new Date().toISOString(), session.timezone));
  const [minutes, setMinutes] = useState(activity?.durationSeconds ? String(Math.round(activity.durationSeconds / 60)) : '');
  const [outcome, setOutcome] = useState<string | null>(activity?.outcomeCode ?? null);
  const [subject, setSubject] = useState(activity?.subject ?? '');
  const [body, setBody] = useState(activity?.body ?? '');
  const [performer, setPerformer] = useState<PickedMember | null>(null);
  const [followUp, setFollowUp] = useState(false);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ids = { body: useId(), when: useId(), minutes: useId(), subject: useId() };
  const timed = type === 'call' || type === 'meeting';
  const note = type === 'note';

  const submit = async () => {
    const errors: Record<string, string> = {};
    const occurredAt = zonedToInstant(when, session.timezone);
    if (occurredAt === null) errors['occurredAt'] = t('whenInvalid');
    else if (new Date(occurredAt).getTime() > Date.now() + 5 * 60_000) errors['occurredAt'] = t('whenFuture');
    if (note && body.trim() === '') errors['body'] = t('noteRequired');
    const duration = minutes.trim() === '' ? null : Number(minutes);
    if (duration !== null && (!Number.isInteger(duration) || duration < 0 || duration > 1440)) errors['durationSeconds'] = t('durationInvalid');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const fields = {
        subject: subject.trim() || null,
        body: body.trim() || null,
        occurredAt: occurredAt!,
        ...(timed ? { durationSeconds: duration === null ? null : duration * 60 } : {}),
        outcomeCode: note ? null : outcome,
        ...(note ? {} : { direction }),
      };
      if (editing) {
        const changes: EditActivityBody = fields;
        await bff<ActivityDetailDto>(`activities/${activity.id}`, { method: 'PATCH', version: activity.version, body: changes });
        announce(t('edited'));
      } else {
        const created: LogActivityBody = {
          ...fields,
          activityType: type,
          ...(note ? { direction: 'internal' as const } : {}),
          ...(performer ? { performedBy: performer.membershipId } : {}),
          links: links.map(({ entityType, entityId }) => ({ entityType, entityId })),
        };
        await bff<ActivityDetailDto>('activities', { method: 'POST', body: created });
        announce(t('logged', { type: t(`type.${type}`) }));
      }
      await refresh();
      onClose();
      if (followUp) onScheduleFollowUp?.();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (field: string) => clientErrors[field] ?? fieldErrorsOf(error)[field];
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={editing ? t('editTitle') : t('logTitle')}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {editing ? common('save') : t('save')}
          </Button>
        </>
      }
    >
      <div className={formClass}>
        {error instanceof ApiError && error.status === 412 ? (
          <Notice tone="warning" title={common('conflictTitle')}>
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem
            error={error}
            clientErrors={clientErrors}
            fields={{
              body: { label: note ? t('note') : t('notes'), id: ids.body },
              occurredAt: { label: t('when'), id: ids.when },
              durationSeconds: { label: t('duration'), id: ids.minutes },
              subject: { label: t('subject'), id: ids.subject },
            }}
          />
        )}
        {editing ? (
          <p>{t('editWindow')}</p>
        ) : (
          <RadioGroupField label={t('typeLabel')} value={type} onChange={(value) => setType(value as LoggableType)} options={LOGGABLE_TYPES.map((id) => ({ id, label: t(`type.${id}`) }))} />
        )}
        {!note ? (
          <RadioGroupField
            label={t('direction')}
            value={direction}
            onChange={(value) => setDirection(value as 'inbound' | 'outbound')}
            options={[
              { id: 'outbound', label: t('directionValue.outbound') },
              { id: 'inbound', label: t('directionValue.inbound') },
            ]}
          />
        ) : null}
        <FieldRow>
          <TextField id={ids.when} label={t('when')} description={t('inZone', { zone: session.timezone })} type="datetime-local" value={when} onChange={setWhen} isRequired error={fieldError('occurredAt')} />
          {timed ? (
            <TextField id={ids.minutes} label={t('duration')} type="number" inputMode="numeric" min="0" max="1440" value={minutes} onChange={setMinutes} error={fieldError('durationSeconds')} />
          ) : null}
        </FieldRow>
        {!note ? (
          <SelectField
            label={t('outcome')}
            value={outcome ?? '__none__'}
            onChange={(value) => setOutcome(value === '__none__' ? null : value)}
            options={[{ id: '__none__', label: common('none') }, ...(outcomes.data?.data ?? []).map((value) => ({ id: value.code, label: value.label }))]}
          />
        ) : null}
        {type === 'email' || type === 'meeting' ? <TextField id={ids.subject} label={t('subject')} value={subject} onChange={setSubject} maxLength={300} dir="auto" error={fieldError('subject')} /> : null}
        <TextField
          id={ids.body}
          label={note ? t('note') : t('notes')}
          description={t('bodyHelp')}
          value={body}
          onChange={setBody}
          multiline
          maxLength={10_000}
          dir="auto"
          isRequired={note}
          error={fieldError('body')}
        />
        {!editing ? (
          <>
            <PeoplePicker label={t('performedBy')} description={t('performedByHelp')} value={performer} onChange={setPerformer} permission="contact.view" />
            <p>
              {t('linkedTo')}{' '}
              {links.map((link, index) => (
                <span key={`${link.entityType}-${link.entityId}`}>
                  {index > 0 ? ', ' : null}
                  <bdi dir="auto">{link.label}</bdi>
                </span>
              ))}
            </p>
            {onScheduleFollowUp ? (
              <Checkbox isSelected={followUp} onChange={setFollowUp}>
                {t('scheduleFollowUp')}
              </Checkbox>
            ) : null}
          </>
        ) : null}
        <Notice tone="info">{t('recordsOnly')}</Notice>
      </div>
    </Dialog>
  );
}
