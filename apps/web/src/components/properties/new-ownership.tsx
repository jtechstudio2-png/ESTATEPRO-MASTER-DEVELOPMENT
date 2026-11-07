'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useContact } from '@/components/crm/use-crm';
import { ContactSearch } from '@/components/leads/new-lead';
import { Button, LinkButton } from '@/components/ui/button';
import { FieldRow, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass, Page, PageHeader, Panel } from '@/components/ui/layout';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-guard';
import type { AddOwnershipBody, ContactSummaryDto, OwnershipDto, PropertyDto, PropertyPageDto, UnitPageDto } from '@/lib/api-schema';
import { bff, newIdempotencyKey, query } from '@/lib/bff';
import { useRefreshAll } from '@/lib/mutations';

const TYPES = ['legal_owner', 'beneficial_owner', 'leaseholder', 'developer'] as const;
const WHOLE = '__whole__';
const todayLocal = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

/**
 * Records an ownership (property "Ownership" tab; LL-1 "add ownership"). Opened
 * from a property (?propertyId=) the owner is searched for; opened from a
 * contact (?contactId=) the property is. The API checks the share total, the
 * dates in the property's time zone, and that the member may see the contact.
 */
export function NewOwnership() {
  const t = useTranslations('ownership');
  const common = useTranslations('common');
  const router = useRouter();
  const search = useSearchParams();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const presetContactId = search.get('contactId');
  const presetContact = useContact(presetContactId ?? '', presetContactId !== null);
  const [owner, setOwner] = useState<ContactSummaryDto | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(search.get('propertyId'));
  const [propertySearch, setPropertySearch] = useState('');
  const [covers, setCovers] = useState<string>(WHOLE);
  const [ownershipType, setOwnershipType] = useState<(typeof TYPES)[number]>('legal_owner');
  const [share, setShare] = useState('100');
  const [effectiveFrom, setEffectiveFrom] = useState(todayLocal());
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const ids = { owner: useId(), property: useId(), unit: useId(), share: useId(), from: useId() };
  const ownerId = presetContactId ?? owner?.id ?? null;
  const fromContact = presetContactId !== null;

  const properties = useQuery({
    queryKey: ['list', 'ownership-properties', propertySearch],
    queryFn: () => bff<PropertyPageDto>(`properties${query({ q: propertySearch, limit: 20 })}`),
    enabled: propertySearch.trim().length >= 2,
  });
  const property = useQuery({ queryKey: ['record', 'property', propertyId], queryFn: () => bff<PropertyDto>(`properties/${propertyId}`), enabled: propertyId !== null });
  const units = useQuery({ queryKey: ['record', 'units-for-select', propertyId], queryFn: () => bff<UnitPageDto>(`properties/${propertyId}/units?limit=100`), enabled: propertyId !== null });

  const backHref = fromContact ? `/contacts/${presetContactId}/properties` : propertyId ? `/properties/${propertyId}/ownership` : '/properties';
  const fieldError = (field: string) => clientErrors[field] ?? fieldErrorsOf(error)[field];

  const submit = async () => {
    const errors: Record<string, string> = {};
    if (ownerId === null) errors['ownerContactId'] = t('chooseOwner');
    if (propertyId === null) errors['propertyId'] = t('chooseProperty');
    const sharePercent = Number(share.replace(',', '.'));
    if (!Number.isFinite(sharePercent) || sharePercent <= 0 || sharePercent > 100) errors['sharePercent'] = t('shareInvalid');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const body: AddOwnershipBody = {
        ownerContactId: ownerId!,
        unitId: covers === WHOLE ? null : covers,
        sharePercent,
        ownershipType,
        effectiveFrom,
      };
      await bff<OwnershipDto>(`properties/${propertyId}/ownerships`, { method: 'POST', body, idempotencyKey });
      announce(t('added'));
      setDirty(false);
      await refresh();
      router.push(fromContact ? `/contacts/${presetContactId}/properties` : `/properties/${propertyId}/ownership`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <UnsavedChangesGuard dirty={dirty && !busy} />
      <PageHeader title={t('newTitle')} subtitle={t('newSubtitle')} back={{ href: backHref, label: fromContact ? t('backToContact') : t('backToProperty') }} />
      <form
        className={formClass}
        noValidate
        onChange={() => setDirty(true)}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormProblem
          error={error}
          clientErrors={clientErrors}
          fields={{
            ownerContactId: { label: t('ownerSearch'), id: ids.owner },
            propertyId: { label: t('property'), id: ids.property },
            unitId: { label: t('covers'), id: ids.unit },
            sharePercent: { label: t('sharePercent'), id: ids.share },
            effectiveFrom: { label: t('firstDay'), id: ids.from },
          }}
        />
        <Panel title={t('owner')}>
          {fromContact ? (
            <p>
              <bdi dir="auto">{presetContact.data?.displayName ?? ''}</bdi>
            </p>
          ) : (
            <ContactSearch value={owner} onChange={setOwner} labelId={ids.owner} label={t('ownerSearch')} help={t('ownerHelp')} error={fieldError('ownerContactId')} />
          )}
        </Panel>
        <Panel title={t('property')}>
          {propertyId ? (
            <p>
              <bdi className="ep-num">{property.data?.reference ?? ''}</bdi> · <bdi dir="auto">{property.data?.name ?? property.data?.address.formatted ?? ''}</bdi>{' '}
              {fromContact ? (
                <Button
                  variant="quiet"
                  onPress={() => {
                    setPropertyId(null);
                    setCovers(WHOLE);
                  }}
                >
                  {t('change')}
                </Button>
              ) : null}
            </p>
          ) : (
            <>
              <TextField id={ids.property} label={t('propertySearch')} value={propertySearch} onChange={setPropertySearch} description={t('propertySearchHelp')} autoComplete="off" error={fieldError('propertyId')} />
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={t('propertySearch')}>
                {(properties.data?.data ?? []).map((item) => (
                  <li key={item.id}>
                    <Button variant="quiet" onPress={() => setPropertyId(item.id)}>
                      <bdi className="ep-num">{item.reference}</bdi> · <bdi dir="auto">{item.name ?? item.formattedAddress ?? ''}</bdi>
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {propertyId ? (
            <SelectField
              id={ids.unit}
              label={t('covers')}
              description={t('coversHelp')}
              value={covers}
              onChange={(value) => setCovers(value ?? WHOLE)}
              isRequired
              options={[
                { id: WHOLE, label: t('wholeProperty') },
                ...(units.data?.data ?? []).filter((unit) => unit.archivedAt === null && !unit.isWholeProperty).map((unit) => ({ id: unit.id, label: `${unit.unitLabel} · ${unit.reference}` })),
              ]}
              error={fieldError('unitId')}
            />
          ) : null}
        </Panel>
        <Panel title={t('ownershipType')}>
          <FieldRow>
            <SelectField label={t('ownershipType')} value={ownershipType} onChange={(value) => setOwnershipType((value ?? 'legal_owner') as (typeof TYPES)[number])} isRequired options={TYPES.map((id) => ({ id, label: t(`typeLabel.${id}`) }))} />
            <TextField id={ids.share} label={t('sharePercent')} description={t('shareHelp')} value={share} onChange={setShare} inputMode="decimal" isRequired error={fieldError('sharePercent')} />
            <TextField id={ids.from} label={t('firstDay')} description={t('firstDayHelp')} type="date" value={effectiveFrom} onChange={setEffectiveFrom} isRequired max={todayLocal()} error={fieldError('effectiveFrom')} />
          </FieldRow>
        </Panel>
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            {t('save')}
          </Button>{' '}
          <LinkButton href={backHref}>{common('cancel')}</LinkButton>
        </div>
      </form>
    </Page>
  );
}
