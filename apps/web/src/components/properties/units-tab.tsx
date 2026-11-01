'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton, StatusLabel, type Tone } from '@/components/ui/feedback';
import { Checkbox, FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Facts, Fieldset, formClass, Panel } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, LoadMore, SearchBox } from '@/components/ui/list-controls';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import type { CreateUnitBody, UnitDto, UpdateUnitBody } from '@/lib/api-schema';
import { bffRequest, newIdempotencyKey } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useCountries, usePicklist, usePropertyTypes } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { useProperty } from './use-property';

const AVAILABILITY = ['available', 'under_maintenance', 'owner_occupied', 'unavailable'] as const;
type Availability = (typeof AVAILABILITY)[number];
const TONE: Record<Availability, Tone> = { available: 'success', under_maintenance: 'warning', owner_occupied: 'info', unavailable: 'neutral' };
const NONE = '__none__';

export function AvailabilityLabel({ availability }: { availability: Availability }) {
  const enums = useTranslations('enums');
  return (
    <StatusLabel tone={TONE[availability]} icon={availability === 'under_maintenance' ? '⚠' : undefined}>
      {enums(`availability.${availability}`)}
    </StatusLabel>
  );
}

type UnitDialog = { kind: 'form'; unit: UnitDto | null } | { kind: 'availability' | 'archive' | 'restore' | 'view'; unit: UnitDto };

/** P-4 units tab: the units of a property, their availability, and the unit drawer. */
export function UnitsTab({ propertyId }: { propertyId: string }) {
  const t = useTranslations('units');
  const list = useTranslations('list');
  const enums = useTranslations('enums');
  const common = useTranslations('common');
  const format = useFormat();
  const params = useListParams();
  const { can, readOnly } = useSession();
  const property = useProperty(propertyId);
  const [dialog, setDialog] = useState<UnitDialog | null>(null);
  const writable = !readOnly && property.data?.archivedAt === null;
  const canUpdate = can('property.update') && writable;
  const canArchive = can('property.archive') && writable;

  const query = new URLSearchParams(params.apiQuery);
  query.delete('unit');
  const result = usePagedList<UnitDto>(`properties/${propertyId}/units`, query, { limit: 100 });

  // ?unit=<id> (global search, dashboard) opens that unit's drawer.
  const unitParam = params.get('unit');
  const linked = useQuery({
    queryKey: ['record', 'unit', unitParam],
    queryFn: async () => {
      const response = await bffRequest<UnitDto>(`units/${unitParam}`);
      return { ...response.data, version: response.version ?? response.data.version };
    },
    enabled: unitParam !== null,
  });
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!linked.data || opened.current === linked.data.id) return;
    opened.current = linked.data.id;
    setDialog(canUpdate && linked.data.archivedAt === null ? { kind: 'form', unit: linked.data } : { kind: 'view', unit: linked.data });
  }, [linked.data, canUpdate]);

  const close = () => {
    setDialog(null);
    if (unitParam !== null) params.set({ unit: null });
  };

  const chips: Chip[] = [];
  const q = params.get('q');
  if (q) chips.push({ key: 'q', label: `${list('search')}: ${q}`, onRemove: () => params.set({ q: null }) });
  const availability = params.get('filter[availability]');
  if (availability) chips.push({ key: 'availability', label: `${t('availability')}: ${enums(`availability.${availability as Availability}`)}`, onRemove: () => params.set({ 'filter[availability]': null }) });
  if (params.get('filter[archived]')) chips.push({ key: 'archived', label: `${t('archivedFilter')}: ${t('archivedOnly')}`, onRemove: () => params.set({ 'filter[archived]': null }) });

  const area = (unit: UnitDto) => (unit.floorArea ? `${format.number(unit.floorArea.value)} ${unit.floorArea.unit === 'sqft' ? 'ft²' : 'm²'}` : '—');
  const menu = (unit: UnitDto): MenuAction[] => {
    const actions: MenuAction[] = [{ id: 'view', label: t('details'), onAction: () => setDialog({ kind: 'view', unit }) }];
    if (canUpdate && unit.archivedAt === null) {
      actions.push({ id: 'edit', label: t('edit'), onAction: () => setDialog({ kind: 'form', unit }) });
      actions.push({ id: 'availability', label: t('changeAvailability'), onAction: () => setDialog({ kind: 'availability', unit }) });
    }
    if (canArchive) {
      actions.push(
        unit.archivedAt === null
          ? { id: 'archive', label: t('archive'), onAction: () => setDialog({ kind: 'archive', unit }), danger: true }
          : { id: 'restore', label: t('restore'), onAction: () => setDialog({ kind: 'restore', unit }) },
      );
    }
    return actions;
  };

  return (
    <Panel
      title={t('title')}
      actions={
        canUpdate ? (
          <Button variant="primary" onPress={() => setDialog({ kind: 'form', unit: null })}>
            {t('addUnit')}
          </Button>
        ) : undefined
      }
    >
      <FilterBar chips={chips} onClearAll={() => params.clear()} search={<SearchBox label={t('searchLabel')} value={q ?? ''} onChange={(value) => params.set({ q: value || null })} />}>
        <FilterSelect
          label={t('availability')}
          value={availability}
          onChange={(value) => params.set({ 'filter[availability]': value })}
          options={AVAILABILITY.map((id) => ({ id, label: enums(`availability.${id}`) }))}
        />
        <FilterSelect label={t('archivedFilter')} value={params.get('filter[archived]')} onChange={(value) => params.set({ 'filter[archived]': value })} options={[{ id: 'true', label: t('archivedOnly') }]} />
      </FilterBar>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true">
          <Skeleton />
          <Skeleton />
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState headingLevel={3} title={chips.length > 0 ? t('emptyFiltered') : t('empty')}>{chips.length > 0 ? list('emptyFilteredDetail') : t('emptyDetail')}</EmptyState>
      ) : (
        <DataTable
          caption={t('list')}
          rows={result.rows}
          rowKey={(unit) => unit.id}
          identifier={{
            header: t('unit'),
            href: (unit) => `/properties/${propertyId}/units?unit=${unit.id}`,
            label: (unit) => <bdi>{unit.unitLabel}</bdi>,
            secondary: (unit) => <bdi className="ep-num">{unit.reference}</bdi>,
          }}
          status={{ header: t('availability'), cell: (unit) => (unit.archivedAt ? <StatusLabel tone="neutral">{common('archived')}</StatusLabel> : <AvailabilityLabel availability={unit.availability} />) }}
          columns={[
            { key: 'type', header: t('type'), cell: (unit) => (unit.isWholeProperty ? t('wholeProperty') : (unit.unitType?.name ?? '—')), onCard: true },
            { key: 'beds', header: t('beds'), cell: (unit) => <span className="ep-num">{unit.bedrooms ?? '—'}</span>, align: 'end', onCard: true },
            { key: 'area', header: t('area'), cell: (unit) => <span className="ep-num">{area(unit)}</span>, align: 'end' },
          ]}
          actions={(unit) => <ActionsMenu label={common('moreActions', { name: unit.unitLabel })} actions={menu(unit)} />}
          actionsHeader={common('actions')}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
      {dialog?.kind === 'form' ? <UnitFormDialog propertyId={propertyId} unit={dialog.unit} onClose={close} /> : null}
      {dialog?.kind === 'view' ? <UnitDetailsDialog unit={dialog.unit} onClose={close} /> : null}
      {dialog?.kind === 'availability' ? <AvailabilityDialog unit={dialog.unit} onClose={close} /> : null}
      {dialog?.kind === 'archive' || dialog?.kind === 'restore' ? <ArchiveUnitDialog unit={dialog.unit} mode={dialog.kind} onClose={close} /> : null}
    </Panel>
  );
}

function UnitDetailsDialog({ unit, onClose }: { unit: UnitDto; onClose: () => void }) {
  const t = useTranslations('units');
  const format = useFormat();
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('viewTitle', { label: unit.unitLabel })} drawer>
      <Facts
        items={[
          { label: t('availability'), value: <AvailabilityLabel availability={unit.availability} /> },
          unit.availabilityNote ? { label: t('reason'), value: <span dir="auto">{unit.availabilityNote}</span> } : null,
          unit.availabilityUntil ? { label: t('until'), value: format.date(unit.availabilityUntil) } : null,
          { label: t('type'), value: unit.isWholeProperty ? t('wholeProperty') : (unit.unitType?.name ?? '—') },
          unit.floorLabel ? { label: t('floorLabel'), value: <bdi>{unit.floorLabel}</bdi> } : null,
          unit.bedrooms !== null ? { label: t('bedrooms'), value: format.number(unit.bedrooms) } : null,
          unit.bathrooms !== null ? { label: t('bathrooms'), value: format.number(unit.bathrooms) } : null,
          unit.receptionRooms !== null ? { label: t('receptionRooms'), value: format.number(unit.receptionRooms) } : null,
          unit.floorArea ? { label: t('floorArea'), value: `${format.number(unit.floorArea.value)} ${unit.floorArea.unit === 'sqft' ? 'ft²' : 'm²'}` } : null,
          unit.parkingSpaces !== null ? { label: t('parking'), value: format.number(unit.parkingSpaces) } : null,
          unit.energyRating ? { label: t('energyRating'), value: <bdi>{unit.energyRating}</bdi> } : null,
        ]}
      />
    </Dialog>
  );
}

/** Unit drawer (P-4): add or edit. */
function UnitFormDialog({ propertyId, unit, onClose }: { propertyId: string; unit: UnitDto | null; onClose: () => void }) {
  const t = useTranslations('units');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const property = useProperty(propertyId);
  const countryCode = property.data?.address.countryCode;
  const countries = useCountries();
  const defaultUnit = countries.data?.data.find((country) => country.code === countryCode)?.areaDisplayUnit ?? 'sqm';
  const types = usePropertyTypes({ countryCode, active: true });
  const furnishing = usePicklist('furnishing', countryCode);
  const features = usePicklist('feature', countryCode);
  const [form, setForm] = useState({
    unitLabel: unit?.unitLabel ?? '',
    isWholeProperty: unit?.isWholeProperty ?? false,
    unitTypeId: unit?.unitType?.id ?? null,
    floorLabel: unit?.floorLabel ?? '',
    bedrooms: unit?.bedrooms?.toString() ?? '',
    bathrooms: unit?.bathrooms?.toString() ?? '',
    receptionRooms: unit?.receptionRooms?.toString() ?? '',
    floorAreaValue: unit?.floorArea?.value.toString() ?? '',
    floorAreaUnit: (unit?.floorArea?.unit as 'sqm' | 'sqft' | undefined) ?? null,
    parkingSpaces: unit?.parkingSpaces?.toString() ?? '',
    furnishingCode: unit?.furnishingCode ?? null,
    energyRating: unit?.energyRating ?? '',
    featureCodes: unit?.featureCodes ?? [],
  });
  const [error, setError] = useState<unknown>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const prefix = useId();
  const id = (field: string) => `${prefix}-${field}`;
  const fieldErrors = { ...fieldErrorsOf(error), ...clientErrors };
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  const whole = (value: string) => (value.trim() === '' ? null : Number(value));

  const labels: Record<string, string> = {
    unitLabel: t('label'),
    unitTypeId: t('type'),
    floorLabel: t('floorLabel'),
    bedrooms: t('bedrooms'),
    bathrooms: t('bathrooms'),
    receptionRooms: t('receptionRooms'),
    'floorArea.value': t('floorArea'),
    parkingSpaces: t('parking'),
    furnishingCode: t('furnishing'),
    energyRating: t('energyRating'),
  };

  const submit = async () => {
    const problems: Record<string, string> = {};
    if (form.unitLabel.trim() === '') problems['unitLabel'] = t('labelRequired');
    for (const key of ['bedrooms', 'bathrooms', 'receptionRooms', 'parkingSpaces'] as const) {
      if (form[key].trim() !== '' && !(Number.isInteger(Number(form[key])) && Number(form[key]) >= 0)) problems[key] = t('number');
    }
    if (form.floorAreaValue.trim() !== '' && !(Number(form.floorAreaValue) > 0)) problems['floorArea.value'] = t('positive');
    setClientErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    const fields = {
      unitTypeId: form.unitTypeId,
      floorLabel: form.floorLabel.trim() || null,
      bedrooms: whole(form.bedrooms),
      bathrooms: whole(form.bathrooms),
      receptionRooms: whole(form.receptionRooms),
      floorArea: form.floorAreaValue.trim() === '' ? null : { value: Number(form.floorAreaValue), unit: form.floorAreaUnit ?? defaultUnit },
      parkingSpaces: whole(form.parkingSpaces),
      furnishingCode: form.furnishingCode,
      energyRating: form.energyRating.trim() || null,
      featureCodes: form.featureCodes,
    };
    try {
      if (unit) {
        const body: UpdateUnitBody = { ...fields, unitLabel: form.unitLabel.trim() };
        await bffRequest(`units/${unit.id}`, { method: 'PATCH', version: unit.version, body });
      } else {
        const body: CreateUnitBody = { ...fields, floorArea: fields.floorArea ?? undefined, unitLabel: form.unitLabel.trim(), isWholeProperty: form.isWholeProperty };
        await bffRequest(`properties/${propertyId}/units`, { method: 'POST', idempotencyKey, body });
      }
      announce(t('saved', { label: form.unitLabel.trim() }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const unitTypes = (types.data?.data ?? []).filter((type) => type.appliesTo !== 'property').map((type) => ({ id: type.id, label: type.name }));
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={unit ? t('editTitle', { label: unit.unitLabel }) : t('addTitle')}
      drawer
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {common('save')}
          </Button>
        </>
      }
    >
      <form className={formClass} onSubmit={(event) => event.preventDefault()}>
        {error instanceof ApiError && error.status === 412 ? (
          <Notice tone="warning" title={common('conflictTitle')}>
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem error={error} clientErrors={clientErrors} fields={Object.fromEntries(Object.entries(labels).map(([field, label]) => [field, { label, id: id(field) }]))} />
        )}
        <TextField id={id('unitLabel')} label={t('label')} value={form.unitLabel} onChange={(value) => set('unitLabel', value)} isRequired maxLength={60} description={t('labelHint')} dir="auto" error={fieldErrors['unitLabel']} />
        {unit ? null : (
          <Checkbox isSelected={form.isWholeProperty} onChange={(value) => set('isWholeProperty', value)}>
            {t('isWhole')}
          </Checkbox>
        )}
        <SelectField
          id={id('unitTypeId')}
          label={t('type')}
          value={form.unitTypeId ?? NONE}
          onChange={(value) => set('unitTypeId', value === NONE ? null : value)}
          options={[{ id: NONE, label: common('notSet') }, ...unitTypes]}
          error={fieldErrors['unitTypeId']}
        />
        <FieldRow>
          <TextField id={id('floorLabel')} label={t('floorLabel')} value={form.floorLabel} onChange={(value) => set('floorLabel', value)} maxLength={20} dir="auto" error={fieldErrors['floorLabel']} />
          <TextField id={id('bedrooms')} label={t('bedrooms')} value={form.bedrooms} onChange={(value) => set('bedrooms', value)} inputMode="numeric" error={fieldErrors['bedrooms']} />
          <TextField id={id('bathrooms')} label={t('bathrooms')} value={form.bathrooms} onChange={(value) => set('bathrooms', value)} inputMode="numeric" error={fieldErrors['bathrooms']} />
        </FieldRow>
        <FieldRow>
          <TextField id={id('receptionRooms')} label={t('receptionRooms')} value={form.receptionRooms} onChange={(value) => set('receptionRooms', value)} inputMode="numeric" error={fieldErrors['receptionRooms']} />
          <TextField id={id('parkingSpaces')} label={t('parking')} value={form.parkingSpaces} onChange={(value) => set('parkingSpaces', value)} inputMode="numeric" error={fieldErrors['parkingSpaces']} />
        </FieldRow>
        <FieldRow>
          <TextField id={id('floorArea.value')} label={t('floorArea')} value={form.floorAreaValue} onChange={(value) => set('floorAreaValue', value)} inputMode="decimal" error={fieldErrors['floorArea.value'] ?? fieldErrors['floorArea']} />
          <SelectField
            label={t('areaUnit')}
            value={form.floorAreaUnit ?? defaultUnit}
            onChange={(value) => set('floorAreaUnit', value as 'sqm' | 'sqft')}
            options={[
              { id: 'sqm', label: 'm²' },
              { id: 'sqft', label: 'ft²' },
            ]}
          />
        </FieldRow>
        <FieldRow>
          <SelectField
            id={id('furnishingCode')}
            label={t('furnishing')}
            value={form.furnishingCode ?? NONE}
            onChange={(value) => set('furnishingCode', value === NONE ? null : value)}
            options={[{ id: NONE, label: common('notSet') }, ...(furnishing.data?.data ?? []).map((item) => ({ id: item.code, label: item.label }))]}
            error={fieldErrors['furnishingCode']}
          />
          <TextField id={id('energyRating')} label={t('energyRating')} value={form.energyRating} onChange={(value) => set('energyRating', value)} maxLength={10} dir="ltr" error={fieldErrors['energyRating']} />
        </FieldRow>
        {(features.data?.data.length ?? 0) > 0 ? (
          <Fieldset legend={t('features')}>
            {features.data!.data.map((feature) => (
              <Checkbox
                key={feature.code}
                isSelected={form.featureCodes.includes(feature.code)}
                onChange={(selected) => set('featureCodes', selected ? [...form.featureCodes, feature.code] : form.featureCodes.filter((code) => code !== feature.code))}
              >
                {feature.label}
              </Checkbox>
            ))}
          </Fieldset>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Availability dialog (P-4): a reason is required for maintenance and unavailability. */
function AvailabilityDialog({ unit, onClose }: { unit: UnitDto; onClose: () => void }) {
  const t = useTranslations('units');
  const enums = useTranslations('enums');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [availability, setAvailability] = useState<Availability>(unit.availability);
  const [note, setNote] = useState(unit.availabilityNote ?? '');
  const [until, setUntil] = useState(unit.availabilityUntil ?? '');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const restricted = availability !== 'available';

  const submit = async () => {
    if ((availability === 'under_maintenance' || availability === 'unavailable') && note.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`units/${unit.id}/availability`, {
        method: 'POST',
        version: unit.version,
        body: { availability, note: restricted ? note.trim() || null : null, until: restricted ? until || null : null },
      });
      announce(t('availabilitySaved', { label: unit.unitLabel, availability: enums(`availability.${availability}`) }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('availabilityTitle', { label: unit.unitLabel })}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {common('save')}
          </Button>
        </>
      }
    >
      <form className={formClass} onSubmit={(event) => event.preventDefault()}>
        {error ? <FormProblem error={error} fields={{ note: { label: t('reason'), id: noteId } }} /> : null}
        <RadioGroupField
          label={t('availabilityChoice')}
          value={availability}
          onChange={(value) => setAvailability(value as Availability)}
          options={AVAILABILITY.map((id) => ({ id, label: enums(`availability.${id}`) }))}
        />
        {restricted ? (
          <>
            <TextField
              id={noteId}
              label={t('reason')}
              value={note}
              onChange={(value) => {
                setNote(value);
                setMissing(false);
              }}
              isRequired={availability === 'under_maintenance' || availability === 'unavailable'}
              description={t('reasonHint')}
              maxLength={500}
              dir="auto"
              error={missing ? common('reasonRequired') : fieldErrorsOf(error)['note']}
            />
            <TextField label={t('until')} type="date" value={until} onChange={setUntil} description={t('untilHint')} error={fieldErrorsOf(error)['until']} />
          </>
        ) : null}
      </form>
    </Dialog>
  );
}

function ArchiveUnitDialog({ unit, mode, onClose }: { unit: UnitDto; mode: 'archive' | 'restore'; onClose: () => void }) {
  const t = useTranslations('units');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();

  const submit = async () => {
    if (mode === 'archive' && reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`units/${unit.id}/${mode}`, { method: 'POST', version: unit.version, body: mode === 'archive' ? { reason: reason.trim() } : {} });
      announce(mode === 'archive' ? t('archived', { label: unit.unitLabel }) : t('restored', { label: unit.unitLabel }));
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
      title={mode === 'archive' ? t('archiveTitle', { label: unit.unitLabel }) : t('restoreTitle', { label: unit.unitLabel })}
      consequence={mode === 'archive' ? t('archiveConsequence') : t('restoreConsequence')}
      confirmLabel={mode === 'archive' ? t('archiveConfirm', { label: unit.unitLabel }) : t('restoreConfirm', { label: unit.unitLabel })}
      onConfirm={() => void submit()}
      busy={busy}
      danger={mode === 'archive'}
    >
      {error ? <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} /> : null}
      {mode === 'archive' ? (
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
    </ConfirmDialog>
  );
}
