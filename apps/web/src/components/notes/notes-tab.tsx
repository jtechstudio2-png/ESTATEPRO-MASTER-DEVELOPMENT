'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useProperty } from '@/components/properties/use-property';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { Checkbox, FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Cluster, formClass, Panel } from '@/components/ui/layout';
import { FilterSelect, LoadMore } from '@/components/ui/list-controls';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { When } from '@/components/ui/when';
import type { CreateNoteBody, MemberListDto, NoteDto, NoteRevisionPageDto, UnitPageDto, UpdateNoteBody } from '@/lib/api-schema';
import { bff, bffRequest, newIdempotencyKey, query } from '@/lib/bff';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { NoteMeta } from './note-meta';
import styles from './notes.module.css';

const CATEGORIES = ['general', 'access', 'viewing', 'maintenance', 'legal', 'owner'] as const;
type Category = (typeof CATEGORIES)[number];
type Visibility = NoteDto['visibility'];
const MAX_PINNED = 5;
const MAX_BODY = 10_000;
const WHOLE = '__whole__';

type NoteDialog = { kind: 'history' | 'archive' | 'restore' | 'redact'; note: NoteDto };

/** Whether the member may change this note (notes.service assertCanChange); the API decides. */
function useCanChange() {
  const { can, session, readOnly } = useSession();
  return (note: NoteDto) => !readOnly && (can('property_note.manage') || (can('property_note.create') && note.author?.membershipId === session.membershipId));
}

/**
 * N-1 notes tab: pinned first, then the rest, filtered by category, unit,
 * audience, author and archive state. Note text is plain text, never markup.
 */
export function NotesTab({ propertyId }: { propertyId: string }) {
  const t = useTranslations('notes');
  const list = useTranslations('list');
  const params = useListParams();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { can, readOnly } = useSession();
  const canChange = useCanChange();
  const property = useProperty(propertyId);
  const manage = can('property_note.manage') && !readOnly;
  const canCreate = can('property_note.create') && !readOnly && property.data?.archivedAt === null;
  const [composer, setComposer] = useState<NoteDto | 'new' | null>(null);
  const [dialog, setDialog] = useState<NoteDialog | null>(null);
  const units = useQuery({ queryKey: ['record', 'units-for-select', propertyId], queryFn: () => bff<UnitPageDto>(`properties/${propertyId}/units?limit=100`) });
  const authors = useQuery({ queryKey: ['members', 'note-authors'], queryFn: () => bff<MemberListDto>(`members${query({ 'filter[permission]': 'property_note.create' })}`), staleTime: 300_000 });
  const unitLabel = (unitId: string | null) => (unitId ? (units.data?.data.find((unit) => unit.id === unitId)?.unitLabel ?? null) : null);

  const view = params.get('filter[pinned]') === 'true' ? 'pinned' : (params.get('filter[category]') ?? 'all');
  const archived = params.get('filter[archived]') === 'true';
  const listQuery = new URLSearchParams(params.apiQuery);
  listQuery.set('sort', '-createdAt');
  const result = usePagedList<NoteDto>(`properties/${propertyId}/notes`, listQuery, { limit: 25 });
  const pinned = useQuery({
    queryKey: ['record', 'notes-pinned', propertyId],
    queryFn: () => bff<{ data: NoteDto[] }>(`properties/${propertyId}/notes?filter[pinned]=true&limit=${MAX_PINNED}`),
  });
  const pinnedCount = pinned.data?.data.length ?? 0;
  const showPinnedSection = view === 'all' && !archived && params.apiQuery.toString() === '' && pinnedCount > 0;
  const rows = showPinnedSection ? result.rows.filter((note) => !note.isPinned) : result.rows;

  const togglePin = async (note: NoteDto) => {
    try {
      await bffRequest(`property-notes/${note.id}`, { method: 'PATCH', version: note.version, body: { isPinned: !note.isPinned } });
      announce(note.isPinned ? t('unpinned') : t('pinned'));
      await refresh();
    } catch (error) {
      announce(error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : t('pinLimit', { max: MAX_PINNED }));
    }
  };

  const menu = (note: NoteDto): MenuAction[] => {
    const actions: MenuAction[] = [];
    const changeable = canChange(note) && note.redactedAt === null;
    if (changeable && note.archivedAt === null) {
      actions.push({ id: 'edit', label: t('edit'), onAction: () => setComposer(note) });
      actions.push({ id: 'pin', label: note.isPinned ? t('unpin') : t('pin'), onAction: () => void togglePin(note), isDisabled: !note.isPinned && pinnedCount >= MAX_PINNED });
    }
    if (canChange(note) || manage) actions.push({ id: 'history', label: t('history'), onAction: () => setDialog({ kind: 'history', note }) });
    if (canChange(note)) {
      actions.push(
        note.archivedAt === null
          ? { id: 'archive', label: t('archive'), onAction: () => setDialog({ kind: 'archive', note }) }
          : { id: 'restore', label: t('restore'), onAction: () => setDialog({ kind: 'restore', note }) },
      );
    }
    if (manage && note.redactedAt === null) actions.push({ id: 'redact', label: t('redact'), onAction: () => setDialog({ kind: 'redact', note }), danger: true });
    return actions;
  };

  const renderNote = (note: NoteDto) => (
    <li key={note.id} className={styles.item}>
      <div className={styles.itemMain}>
        <NoteMeta note={note} pinned={note.isPinned} unitLabel={unitLabel(note.unitId)} />
        {note.redactedAt ? (
          <p className={`${styles.body} ${styles.redacted}`}>
            {t('redacted')} · {t.rich('redactedBy', { when: () => <When iso={note.redactedAt!} /> })}
          </p>
        ) : (
          <p className={styles.body} dir="auto">
            {note.body}
          </p>
        )}
        {note.archivedAt ? (
          <p className={styles.edited}>
            {t.rich('archivedOn', { when: () => <When iso={note.archivedAt!} />, reason: note.archivedReason ?? '' })}
          </p>
        ) : null}
      </div>
      <ActionsMenu label={t('actions')} actions={menu(note)} />
    </li>
  );

  const categories = [{ id: 'all', label: t('filters.all') }, { id: 'pinned', label: t('filters.pinned') }, ...CATEGORIES.filter((id) => id !== 'general').map((id) => ({ id, label: t(`category.${id}`) }))];
  return (
    <Panel
      title={t('title')}
      actions={
        canCreate && composer === null ? (
          <Button variant="primary" onPress={() => setComposer('new')}>
            {t('addNote')}
          </Button>
        ) : undefined
      }
    >
      {composer !== null ? <NoteComposer propertyId={propertyId} note={composer === 'new' ? null : composer} units={units.data?.data ?? []} pinnedCount={pinnedCount} onClose={() => setComposer(null)} /> : null}
      <nav aria-label={t('filters.label')} className={styles.categories}>
        {categories.map((category) => {
          const href =
            category.id === 'all'
              ? `/properties/${propertyId}/notes`
              : category.id === 'pinned'
                ? `/properties/${propertyId}/notes?filter[pinned]=true`
                : `/properties/${propertyId}/notes?filter[category]=${category.id}`;
          return (
            <NextLink key={category.id} href={href} aria-current={view === category.id ? 'page' : undefined} className={styles.categoryLink} scroll={false}>
              {category.label}
            </NextLink>
          );
        })}
      </nav>
      <div className={styles.filters}>
        <FilterSelect
          label={t('unit')}
          value={params.get('filter[unitId]')}
          onChange={(value) => params.set({ 'filter[unitId]': value })}
          options={(units.data?.data ?? []).map((unit) => ({ id: unit.id, label: unit.unitLabel }))}
        />
        <FilterSelect
          label={t('audience')}
          value={params.get('filter[visibility]')}
          onChange={(value) => params.set({ 'filter[visibility]': value })}
          options={(['internal', 'landlord', 'tenant'] as const).map((id) => ({ id, label: t(`visibility.${id}`) }))}
        />
        <FilterSelect
          label={t('author')}
          value={params.get('filter[authorId]')}
          onChange={(value) => params.set({ 'filter[authorId]': value })}
          options={(authors.data?.data ?? []).map((member) => ({ id: member.membershipId, label: member.displayName }))}
        />
        <FilterSelect label={t('archivedFilter')} value={params.get('filter[archived]')} onChange={(value) => params.set({ 'filter[archived]': value })} options={[{ id: 'true', label: t('archivedOnly') }]} />
      </div>
      <Notice tone="info">{t('noSecrets')}</Notice>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {showPinnedSection ? (
        <section aria-labelledby="notes-pinned">
          <h3 id="notes-pinned" className={styles.groupHeading}>
            <span aria-hidden="true">📌 </span>
            {t('pinnedHeading', { count: pinnedCount, max: MAX_PINNED })}
          </h3>
          <ul className={styles.list}>{pinned.data!.data.map(renderNote)}</ul>
        </section>
      ) : null}
      {result.isPending ? (
        <div aria-busy="true">
          <Skeleton />
          <Skeleton />
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : rows.length === 0 && !showPinnedSection ? (
        <EmptyState headingLevel={3} title={params.apiQuery.toString() ? t('emptyFiltered') : t('empty')}>
          {params.apiQuery.toString() ? list('emptyFilteredDetail') : t('emptyDetail')}
        </EmptyState>
      ) : (
        <section aria-labelledby="notes-other">
          {showPinnedSection ? (
            <h3 id="notes-other" className={styles.groupHeading}>
              {t('otherHeading')}
            </h3>
          ) : (
            <h3 id="notes-other" className="ep-visually-hidden">
              {t('list')}
            </h3>
          )}
          <ul className={styles.list}>{rows.map(renderNote)}</ul>
          <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={rows.length} />
        </section>
      )}
      {dialog?.kind === 'history' ? <NoteHistoryDrawer note={dialog.note} onClose={() => setDialog(null)} /> : null}
      {dialog && dialog.kind !== 'history' ? <NoteLifecycleDialog note={dialog.note} action={dialog.kind} onClose={() => setDialog(null)} /> : null}
    </Panel>
  );
}

/** N-2 composer and editor: category, unit, pin and audience; external audiences need managers and a confirmation. */
function NoteComposer({ propertyId, note, units, pinnedCount, onClose }: { propertyId: string; note: NoteDto | null; units: UnitPageDto['data']; pinnedCount: number; onClose: () => void }) {
  const t = useTranslations('notes');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { can } = useSession();
  const property = useProperty(propertyId);
  const manage = can('property_note.manage');
  const [body, setBody] = useState(note?.body ?? '');
  const [category, setCategory] = useState<Category>(note?.category ?? 'general');
  const [unitId, setUnitId] = useState(note?.unitId ?? WHOLE);
  const [visibility, setVisibility] = useState<Visibility>(note?.visibility ?? 'internal');
  const [isPinned, setPinned] = useState(note?.isPinned ?? false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const ids = { body: useId(), unitId: useId() };
  const unitName = units.find((unit) => unit.id === unitId)?.unitLabel ?? '';
  const external = visibility !== 'internal' && visibility !== note?.visibility;

  const validate = () => {
    const problems: Record<string, string> = {};
    if (body.trim() === '') problems['body'] = t('body');
    if (visibility === 'tenant' && unitId === WHOLE) problems['unitId'] = t('tenantNeedsUnit');
    setClientErrors(problems);
    return Object.keys(problems).length === 0;
  };

  const save = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      if (note) {
        const patch: UpdateNoteBody = {
          ...(body.trimEnd() !== note.body ? { body: body.trimEnd() } : {}),
          ...(category !== note.category ? { category } : {}),
          ...(visibility !== note.visibility ? { visibility } : {}),
          ...((unitId === WHOLE ? null : unitId) !== note.unitId ? { unitId: unitId === WHOLE ? null : unitId } : {}),
          ...(isPinned !== note.isPinned ? { isPinned } : {}),
        };
        await bffRequest(`property-notes/${note.id}`, { method: 'PATCH', version: note.version, body: patch });
      } else {
        const create: CreateNoteBody = { body: body.trimEnd(), category, visibility, isPinned, ...(unitId === WHOLE ? {} : { unitId }) };
        await bffRequest(`properties/${propertyId}/notes`, { method: 'POST', idempotencyKey, body: create });
      }
      announce(t('saved'));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!validate()) return;
    if (external) setConfirming(true);
    else void save();
  };

  const errors = { ...fieldErrorsOf(error), ...clientErrors };
  return (
    <section aria-label={note ? t('editorTitle') : t('composerTitle')} className={styles.composer}>
      <h3 className={styles.groupHeading}>{note ? t('editorTitle') : t('composerTitle')}</h3>
      <form
        className={formClass}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error instanceof ApiError && error.status === 412 ? (
          <Notice tone="warning" title={common('conflictTitle')}>
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem error={error} clientErrors={clientErrors} fields={{ body: { label: t('body'), id: ids.body }, unitId: { label: t('unit'), id: ids.unitId } }} />
        )}
        <TextField id={ids.body} label={t('body')} value={body} onChange={setBody} multiline maxLength={MAX_BODY} dir="auto" isRequired autoFocus error={errors['body']} />
        <p className={styles.counter} aria-live="polite">
          {t('chars', { count: body.length, max: MAX_BODY })}
        </p>
        <FieldRow>
          <SelectField label={t('categoryLabel')} value={category} onChange={(value) => setCategory(value as Category)} options={CATEGORIES.map((id) => ({ id, label: t(`category.${id}`) }))} />
          <SelectField
            id={ids.unitId}
            label={t('unit')}
            value={unitId}
            onChange={setUnitId}
            options={[{ id: WHOLE, label: t('wholeProperty') }, ...units.filter((unit) => unit.archivedAt === null).map((unit) => ({ id: unit.id, label: unit.unitLabel }))]}
            error={errors['unitId']}
          />
        </FieldRow>
        <Checkbox isSelected={isPinned} onChange={setPinned} isDisabled={!isPinned && pinnedCount >= MAX_PINNED && !note?.isPinned}>
          {t('pinLabel')}
        </Checkbox>
        {!isPinned && pinnedCount >= MAX_PINNED ? <p className={styles.counter}>{t('pinLimit', { max: MAX_PINNED })}</p> : null}
        <RadioGroupField
          label={t('whoCanRead')}
          value={visibility}
          onChange={(value) => setVisibility(value as Visibility)}
          options={[
            { id: 'internal', label: t('staffOnly') },
            { id: 'landlord', label: t('staffLandlord'), description: manage ? undefined : t('managersOnly'), isDisabled: !manage },
            { id: 'tenant', label: t('staffTenant'), description: manage ? undefined : t('managersOnly'), isDisabled: !manage },
          ]}
          error={errors['visibility']}
        />
        <p className={styles.warning}>⚠ {t('noSecrets')}</p>
        <Cluster>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={submit} busy={busy}>
            {t('saveNote')}
          </Button>
        </Cluster>
      </form>
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={t('shareTitle')}
        consequence={visibility === 'landlord' ? t('shareLandlord', { property: property.data?.name ?? property.data?.reference ?? '' }) : t('shareTenant', { unit: unitName })}
        confirmLabel={t('share')}
        onConfirm={() => void save()}
      />
    </section>
  );
}

/** N-3 note history: earlier wording, newest first (author and managers only). */
function NoteHistoryDrawer({ note, onClose }: { note: NoteDto; onClose: () => void }) {
  const t = useTranslations('notes');
  const [before, setBefore] = useState<number[]>([]);
  const cursor = before[before.length - 1];
  const revisions = useQuery({
    queryKey: ['record', 'note-revisions', note.id, cursor],
    queryFn: () => bff<NoteRevisionPageDto>(`property-notes/${note.id}/revisions${query({ limit: 20, before: cursor })}`),
  });
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('historyTitle', { name: note.author?.displayName ?? '' })} drawer>
      <ol className={styles.revisions}>
        {before.length === 0 ? (
          <li>
            <p className={styles.meta}>{t.rich('current', { version: note.revisionCount + 1, name: (note.updatedBy ?? note.author)?.displayName ?? '', when: () => <When iso={note.updatedAt} /> })}</p>
            <p className={`${styles.body} ${note.redactedAt ? styles.redacted : ''}`} dir="auto">
              {note.redactedAt ? t('redacted') : note.body}
            </p>
          </li>
        ) : null}
        {revisions.isPending ? (
          <Skeleton />
        ) : revisions.isError ? (
          <ErrorNotice error={revisions.error} onRetry={() => void revisions.refetch()} />
        ) : (
          revisions.data.data.map((revision) => (
            <li key={revision.revision}>
              <p className={styles.meta}>
                {t.rich('revision', {
                  version: revision.revision,
                  name: revision.writtenBy?.displayName ?? '',
                  written: () => <When iso={revision.writtenAt} />,
                  replaced: () => <When iso={revision.supersededAt} />,
                })}
              </p>
              <p className={`${styles.body} ${revision.redactedAt ? styles.redacted : ''}`} dir="auto">
                {revision.redactedAt ? t('redacted') : revision.body}
              </p>
            </li>
          ))
        )}
      </ol>
      {revisions.data && revisions.data.data.length === 0 && before.length === 0 ? <p>{t('noRevisions')}</p> : null}
      {revisions.data?.nextBefore ? <Button onPress={() => setBefore([...before, revisions.data.nextBefore!])}>{t('older')}</Button> : null}
    </Dialog>
  );
}

/** N-4 archive, restore and redact (irreversible; the reason is a category). */
function NoteLifecycleDialog({ note, action, onClose }: { note: NoteDto; action: 'archive' | 'restore' | 'redact'; onClose: () => void }) {
  const t = useTranslations('notes');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [reason, setReason] = useState('');
  const [redactReason, setRedactReason] = useState<'erasure_request' | 'sensitive_data' | 'other'>('erasure_request');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();

  const submit = async () => {
    if (action === 'archive' && reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = action === 'archive' ? { reason: reason.trim() } : action === 'redact' ? { reason: redactReason } : {};
      await bffRequest(`property-notes/${note.id}/${action}`, { method: 'POST', version: note.version, body });
      announce(action === 'archive' ? t('archivedDone') : action === 'restore' ? t('restoredDone') : t('redactedDone'));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const copy = {
    archive: { title: t('archiveTitle'), consequence: t('archiveConsequence'), confirm: t('archiveConfirm') },
    restore: { title: t('restoreTitle'), consequence: t('restoreConsequence'), confirm: t('restoreConfirm') },
    redact: { title: t('redactTitle'), consequence: t('redactConsequence'), confirm: t('redactConfirm') },
  }[action];
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={copy.title}
      consequence={copy.consequence}
      confirmLabel={copy.confirm}
      danger={action !== 'restore'}
      busy={busy}
      onConfirm={() => void submit()}
    >
      {error ? <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} /> : null}
      {action === 'archive' ? (
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
      ) : null}
      {action === 'redact' ? (
        <RadioGroupField
          label={t('redactReason')}
          value={redactReason}
          onChange={(value) => setRedactReason(value as typeof redactReason)}
          isRequired
          options={(['erasure_request', 'sensitive_data', 'other'] as const).map((id) => ({ id, label: t(`redactReasons.${id}`) }))}
        />
      ) : null}
    </ConfirmDialog>
  );
}
