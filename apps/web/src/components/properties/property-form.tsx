'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { LocationPicker, type LocationValue } from '@/components/map/location-picker';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Checkbox, FieldRow, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Cluster, Fieldset, formClass, Page, PageHeader } from '@/components/ui/layout';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-guard';
import type { CreatePropertyBody, PropertyDto, UpdatePropertyBody } from '@/lib/api-schema';
import { bffRequest, newIdempotencyKey } from '@/lib/bff';
import { useCountries, useOffices, usePicklist, usePropertyTypes } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { AddressFields, addressFieldIds, type AddressValue, EMPTY_ADDRESS } from './address-fields';
import { propertyTitle, useProperty } from './use-property';

const LAND_UNITS = ['sqm', 'sqft', 'acre', 'hectare', 'plot'] as const;
const NONE = '__none__';

interface FormState {
  name: string;
  propertyTypeId: string | null;
  officeId: string | null;
  isManaged: boolean;
  countryCode: string | null;
  address: AddressValue;
  location: LocationValue | null;
  tenureCode: string | null;
  tenureExpiresOn: string;
  titleReference: string;
  yearBuilt: string;
  floorsCount: string;
  landAreaValue: string;
  landAreaUnit: (typeof LAND_UNITS)[number];
  jurisdictionCode: string;
  timezone: string;
  createWholePropertyUnit: boolean;
}

function fromProperty(property: PropertyDto): FormState {
  const address = property.address;
  return {
    name: property.name ?? '',
    propertyTypeId: property.propertyType.id,
    officeId: property.office.id,
    isManaged: property.isManaged,
    countryCode: address.countryCode,
    address: {
      addressLine1: address.addressLine1 ?? '',
      addressLine2: address.addressLine2 ?? '',
      dependentLocality: address.dependentLocality ?? '',
      locality: address.locality ?? '',
      adminArea2: address.adminArea2 ?? '',
      adminArea1: address.adminArea1 ?? '',
      postalCode: address.postalCode ?? '',
      localComponents: { ...address.localComponents },
    },
    location:
      address.latitude !== null && address.longitude !== null
        ? { latitude: address.latitude, longitude: address.longitude, geocodeSource: address.geocodeSource ?? 'manual_pin', geocodeAccuracy: address.geocodeAccuracy ?? 'rooftop' }
        : null,
    tenureCode: property.tenureCode,
    tenureExpiresOn: property.tenureExpiresOn ?? '',
    titleReference: property.titleReference ?? '',
    yearBuilt: property.yearBuilt === null ? '' : String(property.yearBuilt),
    floorsCount: property.floorsCount === null ? '' : String(property.floorsCount),
    landAreaValue: property.landArea ? String(property.landArea.value) : '',
    landAreaUnit: (property.landArea?.unit as (typeof LAND_UNITS)[number] | undefined) ?? 'sqm',
    jurisdictionCode: property.jurisdictionCode,
    timezone: property.timezone,
    createWholePropertyUnit: false,
  };
}

const text = (value: string) => (value.trim() === '' ? null : value.trim());
const integer = (value: string) => (value.trim() === '' ? null : Number(value));

export function PropertyFormPage({ id }: { id?: string }) {
  const t = useTranslations('properties');
  const property = useProperty(id ?? '', id !== undefined);
  if (!id) return <PropertyForm />;
  if (property.isPending) {
    return (
      <Page>
        <Skeleton width="40%" />
        <Skeleton />
      </Page>
    );
  }
  if (property.isError) {
    return (
      <Page>
        <ErrorNotice error={property.error} onRetry={() => void property.refetch()} />
      </Page>
    );
  }
  if (property.data.archivedAt !== null) {
    return (
      <Page>
        <EmptyState title={t('archivedBanner', { date: '', reason: property.data.archivedReason ?? '' })} action={<LinkButton href={`/properties/${id}`}>{t('backToList')}</LinkButton>} />
      </Page>
    );
  }
  return <PropertyForm property={property.data} onReload={() => void property.refetch()} />;
}

/**
 * P-3 property form (create and edit) with the M-1 location picker. Edits
 * send If-Match; a 412 offers to reload or to keep these changes on the new
 * version. Field errors map from the problem's errors[].
 */
function PropertyForm({ property, onReload }: { property?: PropertyDto; onReload?: () => void }) {
  const t = useTranslations('properties');
  const f = useTranslations('properties.form');
  const address = useTranslations('properties.addressField');
  const common = useTranslations('common');
  const router = useRouter();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { can, session } = useSession();
  const editing = property !== undefined;
  const initial = useMemo<FormState>(
    () =>
      property
        ? fromProperty(property)
        : {
            name: '',
            propertyTypeId: null,
            officeId: session.officeIds[0] ?? null,
            isManaged: false,
            countryCode: session.company.headquartersCountryCode,
            address: EMPTY_ADDRESS,
            location: null,
            tenureCode: null,
            tenureExpiresOn: '',
            titleReference: '',
            yearBuilt: '',
            floorsCount: '',
            landAreaValue: '',
            landAreaUnit: 'sqm',
            jurisdictionCode: '',
            timezone: '',
            createWholePropertyUnit: false,
          },
    [property, session],
  );
  const [form, setForm] = useState<FormState>(initial);
  const [version, setVersion] = useState(property?.version);
  const [locationTouched, setLocationTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);

  const countries = useCountries();
  const country = countries.data?.data.find((item) => item.code === form.countryCode);
  const types = usePropertyTypes({ countryCode: form.countryCode ?? undefined, active: true });
  const { offices } = useOffices(editing ? 'property.update' : 'property.create');
  const tenure = usePicklist('tenure', form.countryCode ?? undefined);

  useEffect(() => {
    if (window.location.hash === '#location') document.getElementById('location')?.scrollIntoView();
  }, []);

  const dirty = !saved && JSON.stringify(form) !== JSON.stringify(initial);
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const fieldErrors = { ...fieldErrorsOf(error), ...clientErrors };
  const ids: Record<string, string> = {
    name: 'pf-name',
    propertyTypeId: 'pf-type',
    officeId: 'pf-office',
    'address.countryCode': 'pf-country',
    'address.latitude': 'pf-latitude',
    'address.longitude': 'pf-latitude',
    tenureCode: 'pf-tenure',
    tenureExpiresOn: 'pf-tenure-expires',
    titleReference: 'pf-title',
    yearBuilt: 'pf-year',
    floorsCount: 'pf-floors',
    'landArea.value': 'pf-land',
    jurisdictionCode: 'pf-jurisdiction',
    timezone: 'pf-timezone',
    ...addressFieldIds('pf-address', country),
  };
  const labels: Record<string, string> = {
    name: f('name'),
    propertyTypeId: f('type'),
    officeId: f('office'),
    'address.countryCode': f('country'),
    'address.latitude': t('location'),
    'address.longitude': t('location'),
    tenureCode: f('tenure'),
    tenureExpiresOn: f('tenureExpires'),
    titleReference: f('titleReference'),
    yearBuilt: f('yearBuilt'),
    floorsCount: f('floors'),
    'landArea.value': f('landArea'),
    jurisdictionCode: f('jurisdiction'),
    timezone: f('timezone'),
  };
  for (const key of ['addressLine1', 'addressLine2', 'dependentLocality', 'locality', 'adminArea2', 'adminArea1', 'postalCode'] as const) labels[`address.${key}`] = address(key);
  for (const component of ((country?.addressFormat as { local_components?: Array<{ key: string; label: string }> } | undefined)?.local_components ?? [])) {
    labels[`address.localComponents.${component.key}`] = component.label;
  }
  const summaryFields = Object.fromEntries(Object.entries(ids).map(([field, id]) => [field, { id, label: labels[field] ?? field }]));

  const addressBody = () => ({
    countryCode: form.countryCode!,
    ...(text(form.address.addressLine1) ? { addressLine1: text(form.address.addressLine1)! } : {}),
    ...(text(form.address.addressLine2) ? { addressLine2: text(form.address.addressLine2)! } : {}),
    ...(text(form.address.dependentLocality) ? { dependentLocality: text(form.address.dependentLocality)! } : {}),
    ...(text(form.address.locality) ? { locality: text(form.address.locality)! } : {}),
    ...(text(form.address.adminArea2) ? { adminArea2: text(form.address.adminArea2)! } : {}),
    ...(text(form.address.adminArea1) ? { adminArea1: text(form.address.adminArea1)! } : {}),
    ...(text(form.address.postalCode) ? { postalCode: text(form.address.postalCode)! } : {}),
    localComponents: Object.fromEntries(Object.entries(form.address.localComponents).filter(([, value]) => value.trim() !== '').map(([key, value]) => [key, value.trim()])),
  });

  const validate = (): Record<string, string> => {
    const problems: Record<string, string> = {};
    if (!form.propertyTypeId) problems['propertyTypeId'] = f('chooseType');
    if (!form.officeId) problems['officeId'] = f('chooseOffice');
    if (!form.countryCode) problems['address.countryCode'] = f('country');
    if (form.landAreaValue.trim() !== '' && !(Number(form.landAreaValue) > 0)) problems['landArea.value'] = f('landArea');
    for (const [key, value] of [['yearBuilt', form.yearBuilt], ['floorsCount', form.floorsCount]] as const) {
      if (value.trim() !== '' && !Number.isInteger(Number(value))) problems[key] = labels[key]!;
    }
    return problems;
  };

  const submit = async () => {
    const problems = validate();
    setClientErrors(problems);
    setError(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      const details = {
        name: text(form.name),
        tenureCode: form.tenureCode,
        tenureExpiresOn: text(form.tenureExpiresOn),
        titleReference: text(form.titleReference),
        yearBuilt: integer(form.yearBuilt),
        floorsCount: integer(form.floorsCount),
        landArea: form.landAreaValue.trim() === '' ? null : { value: Number(form.landAreaValue), unit: form.landAreaUnit },
        isManaged: form.isManaged,
        ...(text(form.jurisdictionCode) ? { jurisdictionCode: text(form.jurisdictionCode)! } : {}),
        ...(text(form.timezone) ? { timezone: text(form.timezone)! } : {}),
      };
      const location = form.location
        ? { latitude: form.location.latitude, longitude: form.location.longitude, geocodeSource: form.location.geocodeSource, geocodeAccuracy: form.location.geocodeAccuracy }
        : { latitude: null, longitude: null };
      if (!property) {
        const body: CreatePropertyBody = {
          ...details,
          propertyTypeId: form.propertyTypeId!,
          officeId: form.officeId!,
          address: { ...addressBody(), ...(form.location ? location : {}) },
          createWholePropertyUnit: form.createWholePropertyUnit,
        };
        const created = await bffRequest<PropertyDto>('properties', { method: 'POST', idempotencyKey, body });
        setSaved(true);
        announce(t('created', { reference: created.data.reference }));
        await refresh();
        router.push(`/properties/${created.data.id}`);
        return;
      }
      const addressChanged = JSON.stringify(form.address) !== JSON.stringify(initial.address) || form.countryCode !== initial.countryCode;
      const body: UpdatePropertyBody = {
        ...details,
        ...(form.propertyTypeId !== initial.propertyTypeId ? { propertyTypeId: form.propertyTypeId! } : {}),
        ...(form.officeId !== initial.officeId ? { officeId: form.officeId! } : {}),
        // The stored point is kept unless the user placed, confirmed or removed it (ADR-006 L-D2).
        ...(addressChanged || locationTouched ? { address: { ...addressBody(), ...(locationTouched ? location : {}) } } : {}),
      };
      await bffRequest(`properties/${property.id}`, { method: 'PATCH', version, body });
      setSaved(true);
      announce(t('saved', { name: form.name || property.reference }));
      await refresh();
      router.push(`/properties/${property.id}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const conflict = error instanceof ApiError && error.status === 412;
  const typeOptions = (types.data?.data ?? []).filter((type) => type.appliesTo !== 'unit').map((type) => ({ id: type.id, label: type.name }));
  const actions = (
    <Cluster>
      <LinkButton href={property ? `/properties/${property.id}` : '/properties'}>{common('cancel')}</LinkButton>
      <Button variant="primary" onPress={() => void submit()} busy={busy}>
        {common('save')}
      </Button>
    </Cluster>
  );

  return (
    <Page>
      <PageHeader
        back={property ? { href: `/properties/${property.id}`, label: propertyTitle(property) } : { href: '/properties', label: t('backToList') }}
        title={property ? t('editProperty') : t('addProperty')}
        actions={actions}
      />
      <UnsavedChangesGuard dirty={dirty} />
      <form
        className={formClass}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {conflict ? (
          <Notice
            tone="warning"
            title={common('conflictTitle')}
            action={
              <Cluster>
                <Button
                  onPress={() => {
                    onReload?.();
                    setError(null);
                  }}
                >
                  {common('conflictReload')}
                </Button>
                <Button
                  variant="primary"
                  onPress={() => {
                    // Keep these edits on top of the latest version: fetch it, then save again.
                    void bffRequest<PropertyDto>(`properties/${property!.id}`).then((latest) => {
                      setVersion(latest.version ?? latest.data.version);
                      setError(null);
                    });
                  }}
                >
                  {f('keepMine')}
                </Button>
              </Cluster>
            }
          >
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem error={error} clientErrors={clientErrors} fields={summaryFields} />
        )}
        <Fieldset legend={f('basics')}>
          <TextField id="pf-name" label={f('name')} value={form.name} onChange={(value) => update('name', value)} description={f('nameHint')} maxLength={200} dir="auto" error={fieldErrors['name']} />
          <FieldRow>
            <SelectField id="pf-type" label={f('type')} value={form.propertyTypeId} onChange={(value) => update('propertyTypeId', value)} options={typeOptions} isRequired placeholder={f('chooseType')} error={fieldErrors['propertyTypeId']} />
            <SelectField
              id="pf-office"
              label={f('office')}
              value={form.officeId}
              onChange={(value) => update('officeId', value)}
              options={offices.map((office) => ({ id: office.id, label: office.name }))}
              isRequired
              placeholder={f('chooseOffice')}
              error={fieldErrors['officeId']}
            />
          </FieldRow>
          <Checkbox isSelected={form.isManaged} onChange={(value) => update('isManaged', value)}>
            {f('managed')}
          </Checkbox>
        </Fieldset>
        <Fieldset legend={f('address', { country: country?.name ?? '' })}>
          <SelectField
            id="pf-country"
            label={f('country')}
            value={form.countryCode}
            onChange={(value) => setForm((current) => ({ ...current, countryCode: value, propertyTypeId: null, tenureCode: null, address: { ...current.address, localComponents: {} } }))}
            options={(countries.data?.data ?? []).map((item) => ({ id: item.code, label: item.name }))}
            isRequired
            error={fieldErrors['address.countryCode']}
          />
          <AddressFields country={country} value={form.address} onChange={(value) => update('address', value)} errors={fieldErrors} idPrefix="pf-address" />
        </Fieldset>
        <section id="location" aria-labelledby="pf-location-title">
          <Fieldset legend={<span id="pf-location-title">{f('location')}</span>}>
            <LocationPicker
              value={form.location}
              onChange={(value) => {
                update('location', value);
                setLocationTouched(true);
              }}
              country={country}
              addressText={[form.address.addressLine1, form.address.dependentLocality, form.address.locality].filter(Boolean).join(', ')}
              canSearch={can('property.create') || can('property.update')}
              stale={Boolean(property?.address.locationStale) && !locationTouched}
              errors={{ latitude: fieldErrors['address.latitude'], longitude: fieldErrors['address.longitude'] }}
              latitudeId="pf-latitude"
            />
            {property?.address.locationStale && !locationTouched && form.location ? (
              <div>
                <Button onPress={() => setLocationTouched(true)}>{f('confirmPin')}</Button>
              </div>
            ) : null}
          </Fieldset>
        </section>
        <Fieldset legend={f('details')}>
          <FieldRow>
            <SelectField
              id="pf-tenure"
              label={f('tenure')}
              value={form.tenureCode ?? NONE}
              onChange={(value) => update('tenureCode', value === NONE ? null : value)}
              options={[{ id: NONE, label: common('notSet') }, ...(tenure.data?.data ?? []).map((item) => ({ id: item.code, label: item.label }))]}
              error={fieldErrors['tenureCode']}
            />
            <TextField id="pf-tenure-expires" label={f('tenureExpires')} type="date" value={form.tenureExpiresOn} onChange={(value) => update('tenureExpiresOn', value)} error={fieldErrors['tenureExpiresOn']} />
            <TextField id="pf-title" label={f('titleReference')} value={form.titleReference} onChange={(value) => update('titleReference', value)} maxLength={100} dir="ltr" error={fieldErrors['titleReference']} />
          </FieldRow>
          <FieldRow>
            <TextField id="pf-year" label={f('yearBuilt')} value={form.yearBuilt} onChange={(value) => update('yearBuilt', value)} inputMode="numeric" error={fieldErrors['yearBuilt']} />
            <TextField id="pf-floors" label={f('floors')} value={form.floorsCount} onChange={(value) => update('floorsCount', value)} inputMode="numeric" error={fieldErrors['floorsCount']} />
            <TextField id="pf-land" label={f('landArea')} value={form.landAreaValue} onChange={(value) => update('landAreaValue', value)} inputMode="decimal" error={fieldErrors['landArea.value'] ?? fieldErrors['landArea']} />
            <SelectField
              label={f('landAreaUnit')}
              value={form.landAreaUnit}
              onChange={(value) => update('landAreaUnit', value as FormState['landAreaUnit'])}
              options={LAND_UNITS.map((unit) => ({ id: unit, label: t(`areaUnit.${unit}`) }))}
            />
          </FieldRow>
          <FieldRow>
            <TextField
              id="pf-jurisdiction"
              label={f('jurisdiction')}
              value={form.jurisdictionCode}
              onChange={(value) => update('jurisdictionCode', value.toUpperCase())}
              description={f('fromOffice')}
              dir="ltr"
              maxLength={6}
              error={fieldErrors['jurisdictionCode']}
            />
            <TextField id="pf-timezone" label={f('timezone')} value={form.timezone} onChange={(value) => update('timezone', value)} description={f('fromOffice')} dir="ltr" maxLength={64} error={fieldErrors['timezone']} />
          </FieldRow>
          {editing ? null : (
            <Checkbox isSelected={form.createWholePropertyUnit} onChange={(value) => update('createWholePropertyUnit', value)}>
              {f('wholeUnit')}
            </Checkbox>
          )}
        </Fieldset>
        {actions}
      </form>
    </Page>
  );
}
