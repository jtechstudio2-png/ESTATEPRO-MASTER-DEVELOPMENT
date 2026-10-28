'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass } from '@/components/ui/layout';
import { LoadMore } from '@/components/ui/list-controls';
import type { MenuAction } from '@/components/ui/menu';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { When } from '@/components/ui/when';
import type { KeyMovementDto, KeySetDto, UnitPageDto } from '@/lib/api-schema';
import { bff, bffRequest, newIdempotencyKey } from '@/lib/bff';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';
import { instantToZoned, todayIn, zonedToInstant } from '@/lib/time';

import styles from './keys.module.css';

export type KeyAction = 'check-out' | 'check-in' | 'lost' | 'found' | 'retire' | 'edit' | 'history';

export function keyWhere(keySet: KeySetDto): string {
  const property = keySet.property.name ?? keySet.property.reference;
  return keySet.unitLabel ? `${property} · ${keySet.unitLabel}` : property;
}

/**
 * The moves a member may make on a key set now (K-1, K-4): the primary one
 * and the rest for the "More actions" menu. Moves the status does not allow
 * are not offered; retire while out is offered and explains why it is blocked.
 */
export function useKeyActions(keySet: KeySetDto, open: (action: KeyAction) => void): { primary: { label: string; action: KeyAction } | null; menu: MenuAction[] } {
  const t = useTranslations('keys');
  const { can, readOnly } = useSession();
  const issue = can('key.issue') && !readOnly;
  const manage = can('key.manage') && !readOnly;
  let primary: { label: string; action: KeyAction } | null = null;
  if (issue && keySet.status === 'in_office') primary = { label: t('checkOut'), action: 'check-out' };
  if (issue && (keySet.status === 'checked_out' || keySet.status === 'with_owner')) primary = { label: t('checkIn'), action: 'check-in' };
  if (issue && keySet.status === 'lost') primary = { label: t('markFound'), action: 'found' };
  const menu: MenuAction[] = [];
  if (issue && (keySet.status === 'in_office' || keySet.status === 'checked_out')) menu.push({ id: 'lost', label: t('reportLost'), onAction: () => open('lost') });
  if (manage && keySet.status !== 'retired') menu.push({ id: 'edit', label: t('edit'), onAction: () => open('edit') });
  menu.push({ id: 'history', label: t('history'), onAction: () => open('history') });
  if (manage && keySet.status !== 'retired') menu.push({ id: 'retire', label: t('retire'), onAction: () => open('retire'), danger: true });
  return { primary, menu };
}

interface KeyDialogsProps {
  keySet: KeySetDto | null;
  action: KeyAction | null;
  onClose: () => void;
}

/** K-3, K-4, K-5 (edit) and K-6 for one key set. */
export function KeyDialogs({ keySet, action, onClose }: KeyDialogsProps) {
  if (keySet === null || action === null) return null;
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  switch (action) {
    case 'check-out':
      return <CheckOutDialog keySet={keySet} onOpenChange={close} />;
    case 'check-in':
      return <MoveDialog keySet={keySet} move="check-in" onOpenChange={close} />;
    case 'lost':
      return <MoveDialog keySet={keySet} move="report-lost" onOpenChange={close} />;
    case 'found':
      return <MoveDialog keySet={keySet} move="found" onOpenChange={close} />;
    case 'retire':
      return <RetireDialog keySet={keySet} onOpenChange={close} />;
    case 'edit':
      return <KeySetFormDialog propertyId={keySet.property.id} propertyName={keySet.property.name ?? keySet.property.reference} keySet={keySet} onOpenChange={close} />;
    case 'history':
      return <KeyHistoryDrawer keySet={keySet} onOpenChange={close} />;
  }
}

function defaultDueBack(timeZone: string): string {
  const now = instantToZoned(new Date().toISOString(), timeZone);
  const today = todayIn(timeZone);
  if (now < `${today}T16:00`) return `${today}T17:00`;
  const later = instantToZoned(new Date(Date.now() + 2 * 3_600_000).toISOString(), timeZone);
  return `${later.slice(0, 14)}00`;
}

function CheckOutDialog({ keySet, onOpenChange }: { keySet: KeySetDto; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const zone = keySet.property.timezone;
  const [holder, setHolder] = useState<PickedMember | null>(null);
  const [due, setDue] = useState(() => defaultDueBack(zone));
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ids = { holder: useId(), due: useId(), note: useId() };
  const fieldErrors = { ...fieldErrorsOf(error), ...clientErrors };

  const submit = async () => {
    const problems: Record<string, string> = {};
    if (holder === null) problems['holderMembershipId'] = t('required', { field: t('staffMember') });
    const dueBackAt = due ? zonedToInstant(due, zone) : null;
    if (due && dueBackAt === null) problems['dueBackAt'] = t('required', { field: t('dueDate') });
    setClientErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`key-sets/${keySet.id}/check-out`, {
        method: 'POST',
        version: keySet.version,
        body: { holderMembershipId: holder!.membershipId, ...(dueBackAt ? { dueBackAt } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      });
      announce(t('checkedOut', { tag: keySet.label, name: holder!.displayName }));
      await refresh();
      onOpenChange(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen
      onOpenChange={onOpenChange}
      title={t('checkOutTitle', { tag: keySet.label, where: keyWhere(keySet) })}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={() => onOpenChange(false)} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {t('checkOut')}
          </Button>
        </>
      }
    >
      <form className={formClass} onSubmit={(event) => event.preventDefault()}>
        <FormProblem
          error={error}
          clientErrors={clientErrors}
          fields={{ holderMembershipId: { label: t('staffMember'), id: ids.holder }, dueBackAt: { label: t('dueDate'), id: ids.due }, note: { label: t('note'), id: ids.note } }}
        />
        <RadioGroupField
          label={t('givenTo')}
          value="member"
          onChange={() => undefined}
          options={[
            { id: 'member', label: t('staffMember') },
            { id: 'contact', label: t('contactPhase5'), isDisabled: true },
          ]}
        />
        <PeoplePicker label={t('staffMember')} value={holder} onChange={setHolder} isRequired error={fieldErrors['holderMembershipId']} />
        <TextField id={ids.due} label={t('dueDate')} type="datetime-local" value={due} onChange={setDue} description={t('dueHint', { zone })} error={fieldErrors['dueBackAt']} />
        <TextField id={ids.note} label={t('note')} value={note} onChange={setNote} maxLength={500} dir="auto" error={fieldErrors['note']} />
      </form>
    </Dialog>
  );
}

type Move = 'check-in' | 'report-lost' | 'found';

function MoveDialog({ keySet, move, onOpenChange }: { keySet: KeySetDto; move: Move; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('keys');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const required = move === 'report-lost';
  const [missing, setMissing] = useState(false);

  const submit = async () => {
    if (required && note.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`key-sets/${keySet.id}/${move}`, { method: 'POST', version: keySet.version, body: note.trim() ? { note: note.trim() } : {} });
      announce(move === 'check-in' ? t('checkedIn', { tag: keySet.label }) : move === 'found' ? t('found', { tag: keySet.label }) : t('reportedLost', { tag: keySet.label }));
      await refresh();
      onOpenChange(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const holderName = keySet.holder ? (keySet.holder.type === 'contact' ? t('contactHolder', { name: keySet.holder.displayName }) : keySet.holder.displayName) : null;
  const title = move === 'check-in' ? t('checkInTitle', { tag: keySet.label }) : move === 'found' ? t('foundTitle', { tag: keySet.label }) : t('lostTitle', { tag: keySet.label });
  const label = move === 'check-in' ? t('checkIn') : move === 'found' ? t('markFound') : t('reportLost');
  const consequence =
    move === 'check-in' ? (
      keySet.status === 'with_owner' ? (
        t('withOwnerNow')
      ) : holderName && keySet.checkedOutAt ? (
        <>
          {t.rich('heldBy', { name: holderName, when: () => <When iso={keySet.checkedOutAt!} timeZone={keySet.property.timezone} /> })}
        </>
      ) : null
    ) : move === 'found' ? (
      t('foundConsequence')
    ) : holderName ? (
      t('whoHadThem', { name: holderName })
    ) : null;

  return (
    <ConfirmDialog
      isOpen
      onOpenChange={onOpenChange}
      title={title}
      consequence={consequence}
      confirmLabel={`${label} ${keySet.label}`}
      onConfirm={() => void submit()}
      busy={busy}
      danger={move === 'report-lost'}
    >
      {error ? <FormProblem error={error} fields={{ note: { label: t('note'), id: noteId } }} /> : null}
      <TextField
        id={noteId}
        label={move === 'report-lost' ? t('whatHappened') : t('note')}
        value={note}
        onChange={(value) => {
          setNote(value);
          setMissing(false);
        }}
        isRequired={required}
        maxLength={500}
        dir="auto"
        error={missing ? t('required', { field: t('whatHappened') }) : fieldErrorsOf(error)['note']}
      />
      {move === 'report-lost' ? <Notice tone="info">{t('considerLocks')}</Notice> : null}
    </ConfirmDialog>
  );
}

function RetireDialog({ keySet, onOpenChange }: { keySet: KeySetDto; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const blocked = keySet.status === 'checked_out';

  const submit = async () => {
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`key-sets/${keySet.id}/retire`, { method: 'POST', version: keySet.version, body: { reason: reason.trim() } });
      announce(t('retired', { tag: keySet.label }));
      await refresh();
      onOpenChange(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      isOpen
      onOpenChange={onOpenChange}
      title={t('retireTitle', { tag: keySet.label })}
      consequence={t('retireConsequence')}
      confirmLabel={`${t('retire')} ${keySet.label}`}
      onConfirm={() => void submit()}
      busy={busy}
      danger
      canConfirm={!blocked}
    >
      {blocked ? <Notice tone="warning" title={t('retireBlocked')} /> : null}
      {error ? <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} /> : null}
      <TextField
        id={reasonId}
        label={common('reason')}
        value={reason}
        onChange={(value) => {
          setReason(value);
          setMissing(false);
        }}
        isRequired
        isDisabled={blocked}
        maxLength={500}
        dir="auto"
        error={missing ? t('required', { field: common('reason') }) : fieldErrorsOf(error)['reason']}
      />
    </ConfirmDialog>
  );
}

/** K-5: add a key set to a property, or edit one. */
export function KeySetFormDialog({
  propertyId,
  propertyName,
  keySet,
  onOpenChange,
}: {
  propertyId: string;
  propertyName: string;
  keySet?: KeySetDto;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [label, setLabel] = useState(keySet?.label ?? '');
  const [unitId, setUnitId] = useState<string>(keySet?.unitId ?? '');
  const [description, setDescription] = useState(keySet?.description ?? '');
  const [status, setStatus] = useState<'in_office' | 'with_owner'>('in_office');
  const [error, setError] = useState<unknown>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const ids = { label: useId(), unitId: useId(), description: useId() };
  const units = useQuery({
    queryKey: ['record', 'units-for-select', propertyId],
    queryFn: () => bff<UnitPageDto>(`properties/${propertyId}/units?limit=100`),
  });
  const fieldErrors = { ...fieldErrorsOf(error), ...clientErrors };
  // A duplicate tag comes back as a conflict; show it on the field (K-5).
  const duplicate = error instanceof ApiError && error.status === 409;
  if (duplicate) fieldErrors['label'] ??= error.problem.detail ?? error.problem.title;

  const submit = async () => {
    if (label.trim() === '') {
      setClientErrors({ label: t('required', { field: t('tag') }) });
      return;
    }
    setClientErrors({});
    setBusy(true);
    setError(null);
    try {
      const body = { label: label.trim(), unitId: unitId || (keySet ? null : undefined), description: description.trim() || (keySet ? null : undefined) };
      if (keySet) {
        await bffRequest(`key-sets/${keySet.id}`, { method: 'PATCH', version: keySet.version, body });
      } else {
        await bffRequest(`properties/${propertyId}/key-sets`, { method: 'POST', idempotencyKey, body: { ...body, status } });
      }
      announce(t('saved', { tag: label.trim() }));
      await refresh();
      onOpenChange(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const unitOptions = [{ id: '', label: t('wholeProperty') }, ...(units.data?.data ?? []).filter((unit) => unit.archivedAt === null).map((unit) => ({ id: unit.id, label: unit.unitLabel }))];
  return (
    <Dialog
      isOpen
      onOpenChange={onOpenChange}
      title={keySet ? t('editTitle', { tag: keySet.label }) : t('addTitle', { property: propertyName })}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={() => onOpenChange(false)} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {keySet ? common('save') : t('addKeySet')}
          </Button>
        </>
      }
    >
      <form className={formClass} onSubmit={(event) => event.preventDefault()}>
        {duplicate ? null : (
          <FormProblem
            error={error}
            clientErrors={clientErrors}
            fields={{ label: { label: t('tag'), id: ids.label }, unitId: { label: t('unit'), id: ids.unitId }, description: { label: t('contents'), id: ids.description } }}
          />
        )}
        <TextField id={ids.label} label={t('tag')} value={label} onChange={setLabel} isRequired maxLength={60} description={t('tagHint')} error={fieldErrors['label']} />
        <SelectField id={ids.unitId} label={t('unit')} value={unitId} onChange={setUnitId} options={unitOptions} error={fieldErrors['unitId']} />
        <TextField id={ids.description} label={t('contents')} value={description} onChange={setDescription} maxLength={500} description={t('contentsHint')} dir="auto" error={fieldErrors['description']} />
        {keySet ? null : (
          <RadioGroupField
            label={t('whereNow')}
            value={status}
            onChange={(value) => setStatus(value as 'in_office' | 'with_owner')}
            options={[
              { id: 'in_office', label: t('status.in_office') },
              { id: 'with_owner', label: t('status.with_owner') },
            ]}
          />
        )}
      </form>
    </Dialog>
  );
}

/** K-6: movements, newest first. */
function KeyHistoryDrawer({ keySet, onOpenChange }: { keySet: KeySetDto; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('keys');
  const list = usePagedList<KeyMovementDto>(`key-sets/${keySet.id}/movements`, new URLSearchParams(), { limit: 25 });
  return (
    <Dialog isOpen onOpenChange={onOpenChange} title={t('historyTitle', { tag: keySet.label })} drawer>
      {list.isPending ? (
        <div aria-busy="true">
          <Skeleton />
          <Skeleton width="80%" />
        </div>
      ) : list.isError ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : list.rows.length === 0 ? (
        <EmptyState headingLevel={3} title={t('noMovements')} />
      ) : (
        <>
          <ol className={styles.timeline}>
            {list.rows.map((movement) => (
              <li key={movement.id}>
                <When iso={movement.occurredAt} timeZone={keySet.property.timezone} />{' '}
                <span>
                  {t(`movement.${movement.movement}`, {
                    holder: movement.holder ? (movement.holder.type === 'contact' ? t('contactHolder', { name: movement.holder.displayName }) : movement.holder.displayName) : '',
                  })}
                </span>
                {movement.dueBackAt ? (
                  <span>
                    {' · '}
                    {t.rich('movementDue', { when: () => <When iso={movement.dueBackAt!} timeZone={keySet.property.timezone} /> })}
                  </span>
                ) : null}
                <span className={styles.meta}> · {t('recordedBy', { name: movement.recordedBy.displayName })}</span>
                {movement.note ? (
                  <p dir="auto" className={styles.note}>
                    {movement.note}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
          <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoad={list.loadMore} shown={list.rows.length} />
        </>
      )}
    </Dialog>
  );
}

/** Opens one key dialog at a time for a list of key sets. */
export function useKeyDialogState() {
  const [state, setState] = useState<{ keySet: KeySetDto; action: KeyAction } | null>(null);
  return {
    open: (keySet: KeySetDto, action: KeyAction) => setState({ keySet, action }),
    dialogs: <KeyDialogs keySet={state?.keySet ?? null} action={state?.action ?? null} onClose={() => setState(null)} />,
  };
}
