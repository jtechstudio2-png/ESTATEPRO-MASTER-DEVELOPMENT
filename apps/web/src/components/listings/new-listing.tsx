'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Cluster, Fieldset, formClass, Page, PageHeader } from '@/components/ui/layout';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-guard';
import type { CreateListingBody, CurrencyListDto, ListingDto, LocaleListDto, PropertyDto, PropertyPageDto, UnitPageDto } from '@/lib/api-schema';
import { bff, bffRequest, newIdempotencyKey, query } from '@/lib/bff';
import { useOffices } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

const FREQUENCIES = ['monthly', 'weekly', 'quarterly', 'semi_annual', 'annual'] as const;
const OFFICE_DEFAULT = '__property__';

/** L-2 new listing: unit, type, office, agent, price and title; starts as a draft. */
export function NewListing() {
  const t = useTranslations('listings');
  const n = useTranslations('listings.new');
  const common = useTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { session, grant } = useSession();
  const ownOnly = grant('listing.create')?.scope === 'own';
  const { offices } = useOffices('listing.create');

  const [propertySearch, setPropertySearch] = useState('');
  const [propertyId, setPropertyId] = useState<string | null>(searchParams.get('propertyId'));
  const [unitId, setUnitId] = useState<string | null>(null);
  const [listingType, setListingType] = useState<'rent' | 'sale'>('rent');
  const [officeId, setOfficeId] = useState(OFFICE_DEFAULT);
  const [agent, setAgent] = useState<PickedMember | null>(ownOnly ? { membershipId: session.membershipId, displayName: session.user.displayName } : null);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<(typeof FREQUENCIES)[number]>('monthly');
  const [title, setTitle] = useState('');
  const [locale, setLocale] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);

  const properties = useQuery({
    queryKey: ['new-listing-properties', propertySearch],
    queryFn: () => bff<PropertyPageDto>(`properties${query({ q: propertySearch, limit: 20 })}`),
    enabled: propertySearch.trim().length >= 2,
  });
  const property = useQuery({ queryKey: ['record', 'property', propertyId], queryFn: () => bff<PropertyDto>(`properties/${propertyId}`), enabled: propertyId !== null });
  const units = useQuery({ queryKey: ['record', 'units-for-select', propertyId], queryFn: () => bff<UnitPageDto>(`properties/${propertyId}/units?limit=100`), enabled: propertyId !== null });
  const currencies = useQuery({ queryKey: ['reference', 'currencies'], queryFn: () => bff<CurrencyListDto>('reference/currencies'), staleTime: 600_000 });
  const locales = useQuery({ queryKey: ['reference', 'locales'], queryFn: () => bff<LocaleListDto>('reference/locales'), staleTime: 600_000 });

  // Defaults from the property's office: currency and listing language.
  const effectiveOffice = officeId === OFFICE_DEFAULT ? property.data?.office.id : officeId;
  const office = offices.find((item) => item.id === effectiveOffice);
  useEffect(() => {
    if (office && currency === null) setCurrency(office.currencyCode);
    if (office && locale === null) setLocale(office.localeCode);
  }, [office, currency, locale]);

  const fieldErrors = { ...fieldErrorsOf(error), ...clientErrors };
  const ids = { unitId: 'nl-unit', price: 'nl-price', title: 'nl-title', agentMembershipId: 'nl-agent', officeId: 'nl-office' };
  const conflict = error instanceof ApiError && error.status === 409 ? error.problem.conflictingResource : undefined;

  const submit = async () => {
    const problems: Record<string, string> = {};
    if (!unitId) problems['unitId'] = n('chooseUnit');
    if (!(Number(amount) > 0)) problems['price.amount'] = n('price');
    if (title.trim() === '') problems['title'] = n('title');
    setClientErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreateListingBody = {
        unitId: unitId!,
        listingType,
        price: { amount: Number(amount).toFixed(2), currency: currency ?? office?.currencyCode ?? session.company.baseCurrencyCode },
        title: title.trim(),
        ...(listingType === 'rent' ? { rentFrequency: frequency } : {}),
        ...(officeId === OFFICE_DEFAULT ? {} : { officeId }),
        ...(agent ? { agentMembershipId: agent.membershipId } : {}),
        ...(locale ? { defaultLocaleCode: locale } : {}),
      };
      const created = await bffRequest<ListingDto>('listings', { method: 'POST', idempotencyKey, body });
      setDone(true);
      announce(n('created', { reference: created.data.reference }));
      await refresh();
      router.push(`/listings/${created.data.id}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const dirty = !done && (unitId !== null || amount !== '' || title !== '');
  const actions = (
    <Cluster>
      <LinkButton href="/listings">{common('cancel')}</LinkButton>
      <Button variant="primary" onPress={() => void submit()} busy={busy}>
        {n('create')}
      </Button>
    </Cluster>
  );

  return (
    <Page>
      <PageHeader back={{ href: '/listings', label: t('title') }} title={n('title')} actions={actions} />
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
          <Notice tone="warning" title={n('conflict', { type: t(`type.${listingType}`) })} action={<NextLink href={`/listings/${conflict.id}`}>{n('openExisting')}</NextLink>} />
        ) : (
          <FormProblem
            error={error}
            clientErrors={clientErrors}
            fields={{
              unitId: { label: n('unit'), id: ids.unitId },
              'price.amount': { label: n('price'), id: ids.price },
              price: { label: n('price'), id: ids.price },
              title: { label: n('title'), id: ids.title },
              agentMembershipId: { label: n('agent'), id: ids.agentMembershipId },
              officeId: { label: n('office'), id: ids.officeId },
            }}
          />
        )}
        <Notice tone="info">{n('draftNote')}</Notice>
        <Fieldset legend={n('unit')}>
          {propertyId && property.data ? (
            <p>
              <bdi>{property.data.name ?? property.data.reference}</bdi>{' '}
              <Button
                size="small"
                variant="quiet"
                onPress={() => {
                  setPropertyId(null);
                  setUnitId(null);
                }}
              >
                {common('edit')}
              </Button>
            </p>
          ) : (
            <>
              <TextField label={n('unitSearch')} value={propertySearch} onChange={setPropertySearch} description={n('unitHint')} autoComplete="off" />
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={n('unitSearch')}>
                {(properties.data?.data ?? []).map((item) => (
                  <li key={item.id}>
                    <Button variant="quiet" onPress={() => setPropertyId(item.id)}>
                      <bdi className="ep-num">{item.reference}</bdi> · <bdi>{item.name ?? item.formattedAddress ?? ''}</bdi>
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {propertyId ? (
            <SelectField
              id={ids.unitId}
              label={n('unit')}
              value={unitId}
              onChange={setUnitId}
              isRequired
              placeholder={n('chooseUnit')}
              options={(units.data?.data ?? []).filter((unit) => unit.archivedAt === null).map((unit) => ({ id: unit.id, label: `${unit.unitLabel} · ${unit.reference}` }))}
              error={fieldErrors['unitId']}
            />
          ) : null}
        </Fieldset>
        <Fieldset legend={t('keyFacts')}>
          <RadioGroupField
            label={n('listingType')}
            value={listingType}
            onChange={(value) => setListingType(value as 'rent' | 'sale')}
            options={[
              { id: 'rent', label: t('type.rent') },
              { id: 'sale', label: t('type.sale') },
            ]}
          />
          <FieldRow>
            <SelectField
              id={ids.officeId}
              label={n('office')}
              value={officeId}
              onChange={setOfficeId}
              options={[{ id: OFFICE_DEFAULT, label: n('officeDefault') }, ...offices.map((item) => ({ id: item.id, label: item.name }))]}
              error={fieldErrors['officeId']}
            />
            {ownOnly ? (
              <TextField label={n('agent')} value={session.user.displayName} onChange={() => undefined} isDisabled description={n('agentSelf')} />
            ) : (
              <PeoplePicker label={n('agent')} value={agent} onChange={setAgent} permission="listing.update" officeId={effectiveOffice} error={fieldErrors['agentMembershipId']} />
            )}
          </FieldRow>
          <FieldRow>
            <SelectField
              label={n('currency')}
              value={currency}
              onChange={setCurrency}
              options={(currencies.data?.data ?? []).map((item) => ({ id: item.code, label: `${item.code} · ${item.name}` }))}
            />
            <TextField id={ids.price} label={n('price')} value={amount} onChange={setAmount} inputMode="decimal" isRequired error={fieldErrors['price.amount'] ?? fieldErrors['price']} />
            {listingType === 'rent' ? (
              <SelectField label={n('frequency')} value={frequency} onChange={(value) => setFrequency(value as (typeof FREQUENCIES)[number])} options={FREQUENCIES.map((id) => ({ id, label: t(`frequencyLabel.${id}`) }))} />
            ) : null}
          </FieldRow>
          <TextField id={ids.title} label={n('title')} value={title} onChange={setTitle} isRequired maxLength={200} dir="auto" error={fieldErrors['title']} />
          <SelectField label={n('language')} value={locale} onChange={setLocale} options={(locales.data?.data ?? []).map((item) => ({ id: item.code, label: item.name }))} />
        </Fieldset>
        {actions}
      </form>
    </Page>
  );
}
