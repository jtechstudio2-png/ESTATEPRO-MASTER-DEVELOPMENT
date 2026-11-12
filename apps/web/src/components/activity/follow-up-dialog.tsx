'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { FieldRow, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass } from '@/components/ui/layout';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import type { CreateTaskBody, TaskDto, UpdateTaskBody } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';
import { instantToZoned, todayIn, zonedToInstant } from '@/lib/time';

import styles from './activity.module.css';

const TASK_TYPES = ['follow_up', 'call', 'email', 'document_chase', 'other'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const REMINDERS = { none: null, '15m': 15, '1h': 60, '1d': 1440 } as const;
type Reminder = keyof typeof REMINDERS;

/** Adds days to a YYYY-MM-DD date. */
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Quick picks (F-1) in the member's time zone: later today (two hours from
 * now, on the hour), tomorrow at 10:00, next Monday at 10:00.
 */
export function quickPick(kind: 'later' | 'tomorrow' | 'nextWeek', timeZone: string, now = new Date()): string {
  const today = todayIn(timeZone, now);
  if (kind === 'later') {
    const later = instantToZoned(new Date(now.getTime() + 2 * 3_600_000).toISOString(), timeZone);
    return `${later.slice(0, 13)}:00`;
  }
  if (kind === 'tomorrow') return `${addDays(today, 1)}T10:00`;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const untilMonday = ((8 - weekday) % 7) || 7;
  return `${addDays(today, untilMonday)}T10:00`;
}

interface FollowUpProps {
  /** What the follow-up is about (one record, schema note G4). */
  about?: { entityType: 'contact' | 'lead'; entityId: string; label: string } | null;
  /** Rescheduling or editing an existing follow-up. */
  task?: TaskDto;
  onClose: () => void;
}

/**
 * F-1 schedule follow-up. Assigning to someone else is for managers (D6,
 * `lead.assign`); everyone else schedules their own. Reminders are in-app in
 * Phase 5; push, email and SMS reminders arrive in Phase 12.
 */
export function FollowUpDialog({ about, task, onClose }: FollowUpProps) {
  const t = useTranslations('followUps');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { session, can } = useSession();
  const zone = session.timezone;
  const editing = task !== undefined;
  const [title, setTitle] = useState(task?.title ?? '');
  const [taskType, setTaskType] = useState<string>(task?.taskType ?? 'follow_up');
  const [due, setDue] = useState(task?.dueAt ? instantToZoned(task.dueAt, zone) : quickPick('tomorrow', zone));
  const [reminder, setReminder] = useState<Reminder>(() => {
    if (!task?.remindAt || !task.dueAt) return 'none';
    const minutes = Math.round((new Date(task.dueAt).getTime() - new Date(task.remindAt).getTime()) / 60_000);
    return (Object.entries(REMINDERS).find(([, value]) => value === minutes)?.[0] as Reminder | undefined) ?? 'none';
  });
  const [priority, setPriority] = useState<string>(task?.priority ?? 'normal');
  const [description, setDescription] = useState(task?.description ?? '');
  const [assignee, setAssignee] = useState<PickedMember | null>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ids = { title: useId(), due: useId() };
  const canAssignOthers = can('lead.assign') && !editing;

  const submit = async () => {
    const errors: Record<string, string> = {};
    if (title.trim() === '') errors['title'] = t('titleRequired');
    const dueAt = zonedToInstant(due, zone);
    if (dueAt === null) errors['dueAt'] = t('dueInvalid');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const minutes = REMINDERS[reminder];
    const remindAt = minutes === null ? null : new Date(new Date(dueAt!).getTime() - minutes * 60_000).toISOString();
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const changes: UpdateTaskBody = { title: title.trim(), taskType: taskType as UpdateTaskBody['taskType'], priority: priority as UpdateTaskBody['priority'], dueAt: dueAt!, remindAt, description: description.trim() || null };
        await bff(`tasks/${task.id}`, { method: 'PATCH', version: task.version, body: changes });
        announce(t('rescheduled', { title: title.trim() }));
      } else {
        const created: CreateTaskBody = {
          title: title.trim(),
          taskType: taskType as CreateTaskBody['taskType'],
          priority: priority as CreateTaskBody['priority'],
          dueAt: dueAt!,
          remindAt,
          description: description.trim() || null,
          ...(assignee ? { assignedTo: assignee.membershipId } : {}),
          ...(about ? { about: { entityType: about.entityType, entityId: about.entityId } } : {}),
        };
        await bff('tasks', { method: 'POST', body: created });
        announce(t('scheduled', { title: title.trim() }));
      }
      await refresh();
      onClose();
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
      title={editing ? t('rescheduleTitle', { title: task.title }) : t('scheduleTitle')}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {editing ? common('save') : t('schedule')}
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
          <FormProblem error={error} clientErrors={clientErrors} fields={{ title: { label: t('what'), id: ids.title }, dueAt: { label: t('when'), id: ids.due } }} />
        )}
        <TextField id={ids.title} label={t('what')} value={title} onChange={setTitle} isRequired maxLength={300} dir="auto" error={fieldError('title')} />
        <SelectField label={t('type')} value={taskType} onChange={setTaskType} options={TASK_TYPES.map((id) => ({ id, label: t(`typeValue.${id}`) }))} />
        <div className={styles.quickPicks} role="group" aria-label={t('quickPicks')}>
          {(['later', 'tomorrow', 'nextWeek'] as const).map((kind) => (
            <Button key={kind} size="small" onPress={() => setDue(quickPick(kind, zone))}>
              {t(`quick.${kind}`)}
            </Button>
          ))}
        </div>
        <FieldRow>
          <TextField id={ids.due} label={t('when')} description={t('inZone', { zone })} type="datetime-local" value={due} onChange={setDue} isRequired error={fieldError('dueAt')} />
          <SelectField label={t('remind')} value={reminder} onChange={(value) => setReminder(value as Reminder)} options={(Object.keys(REMINDERS) as Reminder[]).map((id) => ({ id, label: t(`reminder.${id}`) }))} />
        </FieldRow>
        <FieldRow>
          <SelectField label={t('priority')} value={priority} onChange={setPriority} options={PRIORITIES.map((id) => ({ id, label: t(`priorityValue.${id}`) }))} />
          {canAssignOthers ? (
            <PeoplePicker label={t('assignTo')} description={t('assignToHelp')} value={assignee} onChange={setAssignee} permission="contact.view" />
          ) : (
            <p>{editing ? t('assignedLine', { name: task.assignedTo.name }) : t('assignedToMe')}</p>
          )}
        </FieldRow>
        <TextField label={t('description')} value={description} onChange={setDescription} multiline maxLength={5000} dir="auto" />
        {about ? <p>{t('aboutLine', { label: about.label })}</p> : editing && task.about ? <p>{t('aboutLine', { label: task.about.label })}</p> : null}
        <Notice tone="info">{t('remindersInApp')}</Notice>
      </div>
    </Dialog>
  );
}
