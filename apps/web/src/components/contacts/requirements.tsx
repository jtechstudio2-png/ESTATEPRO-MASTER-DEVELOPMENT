'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { LogActivityDialog } from '@/components/activity/log-activity';
import { useAnnounce } from '@/components/announcer';
import { useContact } from '@/components/crm/use-crm';
import { LocationPicker, type LocationValue } from '@/components/map/location-picker';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { Checkbox, FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Facts, Fieldset, formClass, Panel, Stack } from '@/components/ui/layout';
import { When } from '@/components/ui/when';
import type { ContactDto, CreateRequirementBody, RequirementAreaDto, RequirementAreaInput, RequirementDto, RequirementExclusionDto, RequirementMatchDto, RequirementMatchesDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useCountries, useCurrencies, usePicklist, usePropertyTypes } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import styles from './contacts.module.css';

const FINANCING = ['cash', 'mortgage_approved', 'mortgage_in_progress', 'not_started', 'not_applicable'] as const;
const FREQUENCIES = ['monthly', 'weekly', 'quarterly', 'semi_annual', 'annual'] as const;
const STATUSES = ['active', 'paused', 'fulfilled', 'cancelled'] as const;
const NONE = '__none__';

type AreaInput = RequirementAreaInput;

/** "GH₵900,000 – GH₵1,200,000" or "up to …"; never mixes currencies (B-1). */
export function useBudgetText() {
  const t = useTranslations('requirements');
  const format = useFormat();
  return (requirement: Pick<RequirementDto, 'minPrice' | 'maxPrice' | 'rentFrequency'>) => {
    const min = requirement.minPrice ? format.money(requirement.minPrice) : null;
    const max = requirement.maxPrice ? format.money(requirement.maxPrice) : null;
    const range = min && max ? `${min} – ${max}` : max ? t('upTo', { amount: max }) : min ? t('from', { amount: min }) : t('anyBudget');
    return requirement.rentFrequency ? `${range} ${t(`per.${requirement.rentFrequency}`)}` : range;
  };
}

/** One area as text: a locality, "within 2 km of …" or a drawn shape. */
export function useAreaText() {
  const t = useTranslations('requirements');
  const format = useFormat();
  return (area: RequirementAreaDto | AreaInput) => {
    const label = typeof area.label === 'string' ? area.label : null;
    if (area.kind === 'locality') return [area.locality, area.adminArea1].filter((part) => typeof part === 'string' && part !== '').join(', ');
    if (area.kind === 'radius') return t('radiusArea', { distance: format.distance(Number(area.radiusMetres ?? 0)), place: label ?? t('pinnedPoint') });
    return label ?? t('drawnArea');
  };
}

/**
 * Requirements of one contact (B-2): each with its matches from the
 * company's own published listings (decision D4), "Not suitable" with a
 * reason (gap G2), and "Send to client", which logs an outbound activity
 * linked to the contact and listing (Phase 5 never sends by itself).
 */
export function RequirementsTab({ id }: { id: string }) {
  const t = useTranslations('requirements');
  const { readOnly } = useSession();
  const contact = useContact(id);
  const requirements = useQuery({ queryKey: ['record', 'requirements', id], queryFn: () => bff<RequirementDto[]>(`contacts/${id}/requirements`) });
  const [editing, setEditing] = useState<RequirementDto | 'new' | null>(null);
  const [matching, setMatching] = useState<RequirementDto | null>(null);
  const budget = useBudgetText();
  const areaText = useAreaText();
  const format = useFormat();
  const types = usePropertyTypes();
  if (!contact.data) return null;
  const writable = !readOnly && contact.data.access.canEdit && contact.data.archivedAt === null && !contact.data.isAnonymised;
  const typeName = (typeId: string) => types.data?.data.find((type) => type.id === typeId)?.name ?? '';

  return (
    <Panel
      title={t('title')}
      actions={
        writable ? (
          <Button variant="primary" onPress={() => setEditing('new')}>
            {t('add')}
          </Button>
        ) : undefined
      }
    >
      {requirements.isPending ? (
        <Skeleton />
      ) : requirements.isError ? (
        <ErrorNotice error={requirements.error} onRetry={() => void requirements.refetch()} />
      ) : requirements.data.length === 0 ? (
        <EmptyState title={t('empty')} headingLevel={3}>
          {t('emptyDetail')}
        </EmptyState>
      ) : (
        <ul className={styles.list}>
          {requirements.data.map((requirement) => (
            <li key={requirement.id}>
              <span className={styles.itemMain}>
                <span className={styles.actions}>
                  <strong>{t(`type.${requirement.requirementType}`)}</strong>
                  <StatusLabel tone={requirement.status === 'active' ? 'success' : 'neutral'}>{t(`status.${requirement.status}`)}</StatusLabel>
                </span>
                <span className="ep-num">{budget(requirement)}</span>
                <span className={styles.meta}>
                  {requirement.minBedrooms !== null || requirement.maxBedrooms !== null ? t('beds', { min: requirement.minBedrooms ?? 0, max: requirement.maxBedrooms ?? '' }) : t('anyBeds')}
                  {requirement.propertyTypeIds.length > 0 ? ` · ${requirement.propertyTypeIds.map(typeName).join(', ')}` : ''}
                  {requirement.moveBy ? ` · ${t('moveByLine', { date: format.date(requirement.moveBy) })}` : ''}
                  {requirement.financingStatus ? ` · ${t(`financing.${requirement.financingStatus}`)}` : ''}
                </span>
                {requirement.areas.length > 0 ? (
                  <span className={styles.areas}>
                    {requirement.areas.map((area, index) => (
                      <span key={index} className={styles.tag}>
                        <bdi dir="auto">{areaText(area)}</bdi>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className={styles.meta}>{t('anywhere')}</span>
                )}
              </span>
              <span className={styles.actions}>
                {requirement.status === 'active' ? (
                  <Button size="small" onPress={() => setMatching(requirement)}>
                    {requirement.matchCount === null ? t('matches') : t('matchCount', { count: requirement.matchCount, capped: requirement.matchCountCapped ? 'yes' : 'no' })}
                    <span className="ep-visually-hidden"> {t('forRequirement', { type: t(`type.${requirement.requirementType}`) })}</span>
                  </Button>
                ) : null}
                {writable ? (
                  <Button size="small" onPress={() => setEditing(requirement)}>
                    {t('edit')}
                    <span className="ep-visually-hidden"> {t('forRequirement', { type: t(`type.${requirement.requirementType}`) })}</span>
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing ? <RequirementDialog contact={contact.data} requirement={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {matching ? <MatchesDrawer contact={contact.data} requirement={matching} writable={writable} onClose={() => setMatching(null)} /> : null}
    </Panel>
  );
}

/** B-2 requirement form. Areas are localities or a radius around a pinned point (the Phase 4 picker). */
function RequirementDialog({ contact, requirement, onClose }: { contact: ContactDto; requirement: RequirementDto | null; onClose: () => void }) {
  const t = useTranslations('requirements');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { session } = useSession();
  const currencies = useCurrencies();
  const countries = useCountries();
  const features = usePicklist('feature');
  const types = usePropertyTypes({ appliesTo: 'unit', active: true });
  const areaText = useAreaText();
  const [type, setType] = useState<'buy' | 'rent'>(requirement?.requirementType ?? 'buy');
  const [status, setStatus] = useState<string>(requirement?.status ?? 'active');
  const [currency, setCurrency] = useState(requirement?.currencyCode ?? session.company.baseCurrencyCode);
  const [minPrice, setMinPrice] = useState(requirement?.minPrice?.amount ?? '');
  const [maxPrice, setMaxPrice] = useState(requirement?.maxPrice?.amount ?? '');
  const [frequency, setFrequency] = useState<string>(requirement?.rentFrequency ?? 'monthly');
  const [minBeds, setMinBeds] = useState(requirement?.minBedrooms?.toString() ?? '');
  const [maxBeds, setMaxBeds] = useState(requirement?.maxBedrooms?.toString() ?? '');
  const [typeIds, setTypeIds] = useState<string[]>(requirement?.propertyTypeIds ?? []);
  const [mustHave, setMustHave] = useState<string[]>(requirement?.mustHaveFeatures ?? []);
  // Stored areas come back with null for absent members; the API takes them omitted.
  const [areas, setAreas] = useState<AreaInput[]>(() => (requirement?.areas ?? []).map(({ points, ...area }) => ({ ...area, ...(points ? { points } : {}) })));
  const [locality, setLocality] = useState('');
  const [pickingPoint, setPickingPoint] = useState(false);
  const [point, setPoint] = useState<LocationValue | null>(null);
  const [radiusKm, setRadiusKm] = useState('2');
  const [pointLabel, setPointLabel] = useState('');
  const [moveBy, setMoveBy] = useState(requirement?.moveBy ?? '');
  const [financing, setFinancing] = useState<string>(requirement?.financingStatus ?? NONE);
  const [notes, setNotes] = useState(requirement?.notes ?? '');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ids = { minPrice: useId(), maxPrice: useId(), minBeds: useId(), latitude: useId() };
  const country = countries.data?.data.find((item) => item.code === session.company.headquartersCountryCode);

  const addLocality = () => {
    const name = locality.trim();
    if (name === '') return;
    setAreas([...areas, { kind: 'locality', locality: name }]);
    setLocality('');
  };
  const addRadius = () => {
    if (!point) return;
    const km = Number(radiusKm);
    if (!Number.isFinite(km) || km <= 0 || km > 100) {
      setClientErrors({ ...clientErrors, radius: t('radiusInvalid') });
      return;
    }
    setAreas([...areas, { kind: 'radius', latitude: point.latitude, longitude: point.longitude, radiusMetres: Math.round(km * 1000), ...(pointLabel.trim() ? { label: pointLabel.trim() } : {}) }]);
    setPoint(null);
    setPointLabel('');
    setPickingPoint(false);
  };

  const submit = async () => {
    const errors: Record<string, string> = {};
    const amount = /^\d+(\.\d{1,2})?$/;
    if (minPrice && !amount.test(minPrice)) errors['minPrice'] = t('priceInvalid');
    if (maxPrice && !amount.test(maxPrice)) errors['maxPrice'] = t('priceInvalid');
    if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice)) errors['maxPrice'] = t('priceOrder');
    if (minBeds && maxBeds && Number(minBeds) > Number(maxBeds)) errors['minBedrooms'] = t('bedsOrder');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    const body: Omit<CreateRequirementBody, 'status'> = {
      requirementType: type,
      currencyCode: currency,
      minPrice: minPrice || null,
      maxPrice: maxPrice || null,
      rentFrequency: type === 'rent' ? (frequency as CreateRequirementBody['rentFrequency']) : null,
      minBedrooms: minBeds === '' ? null : Number(minBeds),
      maxBedrooms: maxBeds === '' ? null : Number(maxBeds),
      propertyTypeIds: typeIds,
      areas,
      mustHaveFeatures: mustHave,
      moveBy: moveBy || null,
      financingStatus: financing === NONE ? null : (financing as CreateRequirementBody['financingStatus']),
      notes: notes.trim() || null,
    };
    try {
      if (requirement) {
        await bff(`contacts/${contact.id}/requirements/${requirement.id}`, { method: 'PATCH', version: requirement.version, body: { ...body, status } });
        announce(t('saved'));
      } else {
        await bff(`contacts/${contact.id}/requirements`, { method: 'POST', body: { ...body, status: status === 'paused' ? 'paused' : 'active' } });
        announce(t('created'));
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

  const toggle = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((item) => item !== value));
  const fieldError = (field: string) => clientErrors[field] ?? fieldErrorsOf(error)[field];
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={requirement ? t('editTitle', { name: contact.displayName }) : t('newTitle', { name: contact.displayName })}
      size="wide"
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
      <div className={formClass}>
        {error instanceof ApiError && error.status === 412 ? (
          <Notice tone="warning" title={common('conflictTitle')}>
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem
            error={error}
            clientErrors={clientErrors}
            fields={{ minPrice: { label: t('minPrice'), id: ids.minPrice }, maxPrice: { label: t('maxPrice'), id: ids.maxPrice }, minBedrooms: { label: t('minBeds'), id: ids.minBeds } }}
          />
        )}
        <FieldRow>
          <RadioGroupField
            label={t('typeLabel')}
            value={type}
            onChange={(value) => setType(value as 'buy' | 'rent')}
            options={[
              { id: 'buy', label: t('type.buy') },
              { id: 'rent', label: t('type.rent') },
            ]}
          />
          <SelectField
            label={t('statusLabel')}
            value={status}
            onChange={setStatus}
            options={(requirement ? STATUSES : (['active', 'paused'] as const)).map((id) => ({ id, label: t(`status.${id}`) }))}
          />
        </FieldRow>
        <FieldRow>
          <SelectField label={t('currency')} value={currency} onChange={setCurrency} options={(currencies.data?.data ?? []).map((item) => ({ id: item.code, label: item.code }))} />
          <TextField id={ids.minPrice} label={t('minPrice')} inputMode="decimal" value={minPrice} onChange={setMinPrice} dir="ltr" error={fieldError('minPrice')} />
          <TextField id={ids.maxPrice} label={t('maxPrice')} inputMode="decimal" value={maxPrice} onChange={setMaxPrice} dir="ltr" error={fieldError('maxPrice')} />
          {type === 'rent' ? <SelectField label={t('frequency')} value={frequency} onChange={setFrequency} options={FREQUENCIES.map((id) => ({ id, label: t(`frequencyValue.${id}`) }))} /> : null}
        </FieldRow>
        <p className={styles.meta}>{t('currencyRule')}</p>
        <FieldRow>
          <TextField id={ids.minBeds} label={t('minBeds')} type="number" inputMode="numeric" min="0" max="20" value={minBeds} onChange={setMinBeds} error={fieldError('minBedrooms')} />
          <TextField label={t('maxBeds')} type="number" inputMode="numeric" min="0" max="20" value={maxBeds} onChange={setMaxBeds} error={fieldError('maxBedrooms')} />
        </FieldRow>
        <Fieldset legend={t('propertyTypes')}>
          {(types.data?.data ?? []).map((item) => (
            <Checkbox key={item.id} isSelected={typeIds.includes(item.id)} onChange={(on) => setTypeIds(toggle(typeIds, item.id, on))}>
              {item.name}
            </Checkbox>
          ))}
        </Fieldset>
        <Fieldset legend={t('areas')}>
          {areas.length === 0 ? <p>{t('anywhere')}</p> : null}
          <span className={styles.areas}>
            {areas.map((area, index) => (
              <span key={index} className={styles.tag}>
                <bdi dir="auto">{areaText(area)}</bdi>
                <Button size="small" variant="quiet" onPress={() => setAreas(areas.filter((_, other) => other !== index))} aria-label={t('removeArea', { area: areaText(area) })}>
                  ✕
                </Button>
              </span>
            ))}
          </span>
          <FieldRow>
            <TextField label={t('locality')} description={t('localityHelp')} value={locality} onChange={setLocality} dir="auto" maxLength={100} />
            <div>
              <Button onPress={addLocality} isDisabled={locality.trim() === ''}>
                {t('addLocality')}
              </Button>
            </div>
          </FieldRow>
          {pickingPoint ? (
            <div className={formClass}>
              <LocationPicker value={point} onChange={setPoint} country={country} addressText={locality} canSearch={false} stale={false} errors={{}} latitudeId={ids.latitude} />
              <FieldRow>
                <TextField label={t('radiusKm')} type="number" inputMode="decimal" min="0.1" max="100" value={radiusKm} onChange={setRadiusKm} error={clientErrors['radius']} />
                <TextField label={t('areaLabel')} value={pointLabel} onChange={setPointLabel} dir="auto" maxLength={100} />
              </FieldRow>
              <div className={styles.actions}>
                <Button onPress={addRadius} isDisabled={point === null}>
                  {t('addRadius')}
                </Button>
                <Button variant="quiet" onPress={() => setPickingPoint(false)}>
                  {common('cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button onPress={() => setPickingPoint(true)}>{t('addMapArea')}</Button>
            </div>
          )}
        </Fieldset>
        <Fieldset legend={t('mustHave')}>
          {(features.data?.data ?? []).map((feature) => (
            <Checkbox key={feature.code} isSelected={mustHave.includes(feature.code)} onChange={(on) => setMustHave(toggle(mustHave, feature.code, on))}>
              {feature.label}
            </Checkbox>
          ))}
        </Fieldset>
        <FieldRow>
          <TextField label={t('moveBy')} type="date" value={moveBy} onChange={setMoveBy} error={fieldError('moveBy')} />
          <SelectField label={t('financingLabel')} value={financing} onChange={setFinancing} options={[{ id: NONE, label: common('notSet') }, ...FINANCING.map((id) => ({ id, label: t(`financing.${id}`) }))]} />
        </FieldRow>
        <TextField label={common('notes')} value={notes} onChange={setNotes} multiline maxLength={2000} dir="auto" />
      </div>
    </Dialog>
  );
}

/** B-2 matches drawer: ranked published listings of the company, with the rule breakdown, and exclusions. */
function MatchesDrawer({ contact, requirement, writable, onClose }: { contact: ContactDto; requirement: RequirementDto; writable: boolean; onClose: () => void }) {
  const t = useTranslations('requirements');
  const format = useFormat();
  const features = usePicklist('feature');
  const matches = useQuery({
    queryKey: ['record', 'requirement-matches', requirement.id],
    queryFn: () => bff<RequirementMatchesDto>(`contacts/${contact.id}/requirements/${requirement.id}/matches?limit=20`),
  });
  const exclusions = useQuery({
    queryKey: ['record', 'requirement-exclusions', requirement.id],
    queryFn: () => bff<RequirementExclusionDto[]>(`contacts/${contact.id}/requirements/${requirement.id}/exclusions`),
  });
  const [excluding, setExcluding] = useState<RequirementMatchDto | null>(null);
  const [sending, setSending] = useState<RequirementMatchDto | null>(null);
  const [restoring, setRestoring] = useState<RequirementExclusionDto | null>(null);
  const featureName = (code: string) => features.data?.data.find((feature) => feature.code === code)?.label ?? code;
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('matchesTitle', { name: contact.displayName })} drawer>
      <Stack>
        {matches.isPending ? (
          <Skeleton />
        ) : matches.isError ? (
          <ErrorNotice error={matches.error} onRetry={() => void matches.refetch()} />
        ) : matches.data.data.length === 0 ? (
          <EmptyState title={t('noMatches')} headingLevel={3}>
            {t('noMatchesDetail')}
          </EmptyState>
        ) : (
          <>
            <p>{t('matchTotal', { shown: matches.data.data.length, total: matches.data.total })}</p>
            <ul className={styles.list}>
              {matches.data.data.map((match) => (
                <li key={match.listingId}>
                  <span className={styles.itemMain}>
                    <NextLink href={`/listings/${match.listingId}`}>
                      <bdi dir="ltr" className="ep-num">
                        {match.reference}
                      </bdi>{' '}
                      <bdi dir="auto">{match.title}</bdi>
                    </NextLink>
                    <span>
                      <span className="ep-num">{format.money(match.price)}</span>
                      {match.bedrooms !== null ? ` · ${t('bedrooms', { count: match.bedrooms })}` : ''}
                      {match.locality ? (
                        <>
                          {' · '}
                          <bdi dir="auto">{match.locality}</bdi>
                        </>
                      ) : null}
                    </span>
                    <span className={styles.meta}>
                      {match.publishedAt ? t('publishedOn', { date: format.date(match.publishedAt) }) : null}
                      {match.breakdown.featuresMissing.length > 0 ? ` · ${t('missing', { features: match.breakdown.featuresMissing.map(featureName).join(', ') })}` : ''}
                      {match.breakdown.propertyTypeMatched === false ? ` · ${t('otherType')}` : ''}
                    </span>
                  </span>
                  {writable ? (
                    <span className={styles.actions}>
                      <Button size="small" onPress={() => setSending(match)}>
                        {t('send')}
                        <span className="ep-visually-hidden"> {match.reference}</span>
                      </Button>
                      <Button size="small" onPress={() => setExcluding(match)}>
                        {t('notSuitable')}
                        <span className="ep-visually-hidden"> {match.reference}</span>
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className={styles.meta}>{t('rules', { rules: matches.data.rules.join(' · ') })}</p>
          </>
        )}
        {exclusions.data && exclusions.data.length > 0 ? (
          <Panel title={t('excludedTitle')} headingLevel={3}>
            <ul className={styles.list}>
              {exclusions.data.map((exclusion) => (
                <li key={exclusion.listingId}>
                  <span className={styles.itemMain}>
                    <span>
                      <bdi dir="ltr" className="ep-num">
                        {exclusion.listingReference}
                      </bdi>{' '}
                      <bdi dir="auto">{exclusion.listingTitle}</bdi>
                    </span>
                    <span className={styles.meta}>
                      <bdi dir="auto">{exclusion.reason}</bdi> · {exclusion.excludedBy?.name ?? ''} · <When iso={exclusion.excludedAt} />
                    </span>
                  </span>
                  {writable ? (
                    <Button size="small" onPress={() => setRestoring(exclusion)}>
                      {t('showAgain')}
                      <span className="ep-visually-hidden"> {exclusion.listingReference}</span>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        <Facts items={[{ label: t('matchingNote'), value: t('matchingNoteDetail') }]} />
      </Stack>
      {excluding ? <ExcludeDialog contact={contact} requirement={requirement} match={excluding} onClose={() => setExcluding(null)} /> : null}
      {restoring ? <RestoreExclusionDialog contact={contact} requirement={requirement} exclusion={restoring} onClose={() => setRestoring(null)} /> : null}
      {sending ? (
        <LogActivityDialog
          links={[
            { entityType: 'contact', entityId: contact.id, label: contact.displayName },
            { entityType: 'listing', entityId: sending.listingId, label: sending.reference },
          ]}
          initialType="whatsapp"
          initialDirection="outbound"
          onClose={() => setSending(null)}
        />
      ) : null}
    </Dialog>
  );
}

function ExcludeDialog({ contact, requirement, match, onClose }: { contact: ContactDto; requirement: RequirementDto; match: RequirementMatchDto; onClose: () => void }) {
  const t = useTranslations('requirements');
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
      await bff(`contacts/${contact.id}/requirements/${requirement.id}/exclusions`, { method: 'POST', body: { listingId: match.listingId, reason: reason.trim() } });
      announce(t('excluded', { reference: match.reference }));
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
      title={t('notSuitableTitle', { reference: match.reference })}
      consequence={t('notSuitableConsequence')}
      confirmLabel={t('notSuitable')}
      onConfirm={() => void submit()}
      busy={busy}
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

function RestoreExclusionDialog({ contact, requirement, exclusion, onClose }: { contact: ContactDto; requirement: RequirementDto; exclusion: RequirementExclusionDto; onClose: () => void }) {
  const t = useTranslations('requirements');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await bff(`contacts/${contact.id}/requirements/${requirement.id}/exclusions/${exclusion.listingId}`, { method: 'DELETE' });
      announce(t('restoredMatch', { reference: exclusion.listingReference }));
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
      title={t('showAgainTitle', { reference: exclusion.listingReference })}
      consequence={t('showAgainConsequence')}
      confirmLabel={t('showAgain')}
      onConfirm={() => void submit()}
      busy={busy}
    >
      {error ? <FormProblem error={error} fields={{}} /> : null}
    </ConfirmDialog>
  );
}
