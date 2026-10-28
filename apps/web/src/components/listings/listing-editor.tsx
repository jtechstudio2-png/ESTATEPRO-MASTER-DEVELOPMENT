'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Checkbox, FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Cluster, Fieldset, formClass, Page, PageHeader, Panel } from '@/components/ui/layout';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-guard';
import type { ListingDto, ListingSettingsDto, TranslationDto, UpdateListingBody } from '@/lib/api-schema';
import { bff, bffRequest } from '@/lib/bff';
import { useLocales, usePicklist } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { LIVE } from './listing-labels';
import styles from './listings.module.css';
import { useListing } from './use-listing';

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;
const CHARGE_FREQUENCIES = ['monthly', 'quarterly', 'semi_annual', 'annual'] as const;
const NONE = '__none__';

interface Terms {
  title: string;
  description: string;
  price: string;
  rentFrequency: string;
  advanceRentPeriods: string;
  deposit: string;
  serviceCharge: string;
  serviceChargeFrequency: string;
  minTermMonths: string;
  availableFrom: string;
  priceQualifierCode: string;
  mandateTypeCode: string;
  mandateSignedOn: string;
  mandateExpiresOn: string;
  feeBasis: 'none' | 'percentage' | 'fixed';
  feeRate: string;
  feeAmount: string;
  feeTaxInclusive: boolean;
  priceChangeReason: string;
}

function termsOf(listing: ListingDto): Terms {
  return {
    title: listing.title,
    description: listing.description ?? '',
    price: listing.price.amount,
    rentFrequency: listing.rentFrequency ?? 'monthly',
    advanceRentPeriods: listing.advanceRentPeriods?.toString() ?? '',
    deposit: listing.deposit?.amount ?? '',
    serviceCharge: listing.serviceCharge?.amount ?? '',
    serviceChargeFrequency: listing.serviceChargeFrequency ?? 'monthly',
    minTermMonths: listing.minTermMonths?.toString() ?? '',
    availableFrom: listing.availableFrom ?? '',
    priceQualifierCode: listing.priceQualifierCode ?? NONE,
    mandateTypeCode: listing.mandateTypeCode ?? NONE,
    mandateSignedOn: listing.mandateSignedOn ?? '',
    mandateExpiresOn: listing.mandateExpiresOn ?? '',
    feeBasis: listing.feeTerms?.basis ?? 'none',
    feeRate: listing.feeTerms?.rate ?? '',
    feeAmount: listing.feeTerms?.amount?.amount ?? '',
    feeTaxInclusive: listing.feeTerms?.taxInclusive ?? false,
    priceChangeReason: '',
  };
}

const money = (amount: string, currency: string) => (amount.trim() === '' ? null : { amount: Number(amount).toFixed(2), currency });
const whole = (value: string) => (value.trim() === '' ? null : Number(value));

export function ListingEditorPage({ id }: { id: string }) {
  const listing = useListing(id);
  if (listing.isPending) {
    return (
      <Page>
        <Skeleton />
      </Page>
    );
  }
  if (listing.isError) {
    return (
      <Page>
        <ErrorNotice error={listing.error} onRetry={() => void listing.refetch()} />
      </Page>
    );
  }
  return <ListingEditor listing={listing.data} />;
}

/**
 * L-4 listing editor: commercial terms and the default-language text (PATCH
 * with If-Match), then the translations side by side (PUT/DELETE per
 * language). The price-reduction rule is shown before saving; the API decides.
 */
function ListingEditor({ listing }: { listing: ListingDto }) {
  const t = useTranslations('listings');
  const e = useTranslations('listings.edit');
  const common = useTranslations('common');
  const router = useRouter();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { can } = useSession();
  const initial = termsOf(listing);
  const [form, setForm] = useState<Terms>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const settings = useQuery({ queryKey: ['settings', 'listings'], queryFn: () => bff<ListingSettingsDto>('settings/listings') });
  const qualifiers = usePicklist('price_qualifier');
  const mandates = usePicklist('mandate_type');
  const set = <K extends keyof Terms>(key: K, value: Terms[K]) => setForm((current) => ({ ...current, [key]: value }));
  const currency = listing.price.currency;
  const rent = listing.listingType === 'rent';
  const live = LIVE.includes(listing.status);
  const reduced = Number(form.price) < Number(listing.price.amount);
  const threshold = settings.data?.priceReductionApprovalPercent ?? null;
  const overThreshold = live && reduced && threshold !== null && ((Number(listing.price.amount) - Number(form.price)) / Number(listing.price.amount)) * 100 > threshold;
  const fieldErrors = fieldErrorsOf(error);
  const id = (field: string) => `le-${field.replace(/\W/g, '-')}`;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: UpdateListingBody = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        ...(form.price !== initial.price ? { price: { amount: Number(form.price).toFixed(2), currency } } : {}),
        ...(rent ? { rentFrequency: form.rentFrequency as (typeof FREQUENCIES)[number] } : {}),
        ...(rent
          ? {
              advanceRentPeriods: whole(form.advanceRentPeriods),
              deposit: money(form.deposit, currency),
              serviceCharge: money(form.serviceCharge, currency),
              serviceChargeFrequency: form.serviceCharge.trim() ? (form.serviceChargeFrequency as (typeof CHARGE_FREQUENCIES)[number]) : null,
              minTermMonths: whole(form.minTermMonths),
            }
          : {}),
        availableFrom: form.availableFrom || null,
        priceQualifierCode: form.priceQualifierCode === NONE ? null : form.priceQualifierCode,
        mandateTypeCode: form.mandateTypeCode === NONE ? null : form.mandateTypeCode,
        mandateSignedOn: form.mandateSignedOn || null,
        mandateExpiresOn: form.mandateExpiresOn || null,
        feeTerms:
          form.feeBasis === 'none'
            ? null
            : form.feeBasis === 'percentage'
              ? { basis: 'percentage', rate: form.feeRate.trim(), taxInclusive: form.feeTaxInclusive }
              : { basis: 'fixed', amount: { amount: Number(form.feeAmount).toFixed(2), currency }, taxInclusive: form.feeTaxInclusive },
        ...(form.priceChangeReason.trim() ? { priceChangeReason: form.priceChangeReason.trim() } : {}),
      };
      await bffRequest(`listings/${listing.id}`, { method: 'PATCH', version: listing.version, body });
      setSaved(true);
      announce(e('saved', { reference: listing.reference }));
      await refresh();
      router.push(`/listings/${listing.id}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const labels: Record<string, string> = {
    title: e('titleField'),
    description: e('descriptionField'),
    price: e('price'),
    'price.amount': e('price'),
    priceChangeReason: e('priceReason'),
    advanceRentPeriods: e('advance'),
    'deposit.amount': e('deposit'),
    'serviceCharge.amount': e('serviceCharge'),
    minTermMonths: e('minTerm'),
    availableFrom: e('availableFrom'),
    mandateSignedOn: e('mandateSigned'),
    mandateExpiresOn: e('mandateExpires'),
    'feeTerms.rate': e('feeRate'),
    'feeTerms.amount': e('feeAmount'),
  };
  const actions = (
    <Cluster>
      <LinkButton href={`/listings/${listing.id}`}>{common('cancel')}</LinkButton>
      <Button variant="primary" onPress={() => void submit()} busy={busy}>
        {common('save')}
      </Button>
    </Cluster>
  );

  return (
    <Page>
      <PageHeader back={{ href: `/listings/${listing.id}`, label: listing.reference }} title={e('title', { reference: listing.reference })} actions={actions} />
      <UnsavedChangesGuard dirty={!saved && JSON.stringify(form) !== JSON.stringify(initial)} />
      <form
        className={formClass}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error instanceof ApiError && error.status === 412 ? (
          <Notice tone="warning" title={common('conflictTitle')} action={<Button onPress={() => void refresh().then(() => setError(null))}>{common('conflictReload')}</Button>}>
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem error={error} fields={Object.fromEntries(Object.entries(labels).map(([field, label]) => [field, { label, id: id(field) }]))} />
        )}
        <Fieldset legend={e('terms')}>
          <FieldRow>
            <TextField id={id('price')} label={`${e('price')} (${currency})`} value={form.price} onChange={(value) => set('price', value)} inputMode="decimal" isRequired error={fieldErrors['price.amount'] ?? fieldErrors['price']} />
            {rent ? (
              <SelectField label={t('new.frequency')} value={form.rentFrequency} onChange={(value) => set('rentFrequency', value)} options={FREQUENCIES.map((value) => ({ id: value, label: t(`frequencyLabel.${value}`) }))} />
            ) : null}
            <SelectField
              label={e('qualifier')}
              value={form.priceQualifierCode}
              onChange={(value) => set('priceQualifierCode', value)}
              options={[{ id: NONE, label: common('notSet') }, ...(qualifiers.data?.data ?? []).map((item) => ({ id: item.code, label: item.label }))]}
            />
          </FieldRow>
          {live && reduced ? (
            <>
              <TextField
                id={id('priceChangeReason')}
                label={e('priceReason')}
                value={form.priceChangeReason}
                onChange={(value) => set('priceChangeReason', value)}
                isRequired
                description={e('priceReasonHint')}
                maxLength={500}
                dir="auto"
                error={fieldErrors['priceChangeReason']}
              />
              {overThreshold ? (
                can('listing.approve_price') ? <Notice tone="info">{e('approvalOk')}</Notice> : <Notice tone="warning">{e('approvalWarning', { percent: threshold })}</Notice>
              ) : null}
            </>
          ) : null}
          {rent ? (
            <>
              <FieldRow>
                <TextField id={id('advanceRentPeriods')} label={e('advance')} value={form.advanceRentPeriods} onChange={(value) => set('advanceRentPeriods', value)} inputMode="numeric" error={fieldErrors['advanceRentPeriods']} />
                <TextField id={id('deposit.amount')} label={`${e('deposit')} (${currency})`} value={form.deposit} onChange={(value) => set('deposit', value)} inputMode="decimal" error={fieldErrors['deposit.amount']} />
                <TextField id={id('minTermMonths')} label={e('minTerm')} value={form.minTermMonths} onChange={(value) => set('minTermMonths', value)} inputMode="numeric" error={fieldErrors['minTermMonths']} />
              </FieldRow>
              <FieldRow>
                <TextField id={id('serviceCharge.amount')} label={`${e('serviceCharge')} (${currency})`} value={form.serviceCharge} onChange={(value) => set('serviceCharge', value)} inputMode="decimal" error={fieldErrors['serviceCharge.amount']} />
                <SelectField
                  label={e('serviceChargeFrequency')}
                  value={form.serviceChargeFrequency}
                  onChange={(value) => set('serviceChargeFrequency', value)}
                  options={CHARGE_FREQUENCIES.map((value) => ({ id: value, label: t(`frequencyLabel.${value}`) }))}
                />
              </FieldRow>
            </>
          ) : null}
          <FieldRow>
            <TextField id={id('availableFrom')} label={e('availableFrom')} type="date" value={form.availableFrom} onChange={(value) => set('availableFrom', value)} error={fieldErrors['availableFrom']} />
            <SelectField
              label={e('mandateType')}
              value={form.mandateTypeCode}
              onChange={(value) => set('mandateTypeCode', value)}
              options={[{ id: NONE, label: common('notSet') }, ...(mandates.data?.data ?? []).map((item) => ({ id: item.code, label: item.label }))]}
            />
            <TextField id={id('mandateSignedOn')} label={e('mandateSigned')} type="date" value={form.mandateSignedOn} onChange={(value) => set('mandateSignedOn', value)} error={fieldErrors['mandateSignedOn']} />
            <TextField id={id('mandateExpiresOn')} label={e('mandateExpires')} type="date" value={form.mandateExpiresOn} onChange={(value) => set('mandateExpiresOn', value)} error={fieldErrors['mandateExpiresOn']} />
          </FieldRow>
          <RadioGroupField
            label={e('fee')}
            value={form.feeBasis}
            onChange={(value) => set('feeBasis', value as Terms['feeBasis'])}
            options={[
              { id: 'none', label: e('noFee') },
              { id: 'percentage', label: e('feePercent') },
              { id: 'fixed', label: e('feeFixed') },
            ]}
          />
          {form.feeBasis === 'percentage' ? <TextField id={id('feeTerms.rate')} label={e('feeRate')} value={form.feeRate} onChange={(value) => set('feeRate', value)} inputMode="decimal" error={fieldErrors['feeTerms.rate']} /> : null}
          {form.feeBasis === 'fixed' ? (
            <TextField id={id('feeTerms.amount')} label={`${e('feeAmount')} (${currency})`} value={form.feeAmount} onChange={(value) => set('feeAmount', value)} inputMode="decimal" error={fieldErrors['feeTerms.amount'] ?? fieldErrors['feeTerms.amount.amount']} />
          ) : null}
          {form.feeBasis !== 'none' ? (
            <Checkbox isSelected={form.feeTaxInclusive} onChange={(value) => set('feeTaxInclusive', value)}>
              {e('taxInclusive')}
            </Checkbox>
          ) : null}
        </Fieldset>
        <Fieldset legend={e('text')}>
          <DefaultText listing={listing} form={form} set={set} errors={fieldErrors} idOf={id} />
        </Fieldset>
        {actions}
      </form>
      <TranslationEditor listing={listing} />
    </Page>
  );
}

function DefaultText({ listing, form, set, errors, idOf }: { listing: ListingDto; form: Terms; set: <K extends keyof Terms>(key: K, value: Terms[K]) => void; errors: Record<string, string>; idOf: (field: string) => string }) {
  const e = useTranslations('listings.edit');
  const locales = useLocales();
  const locale = locales.data?.data.find((item) => item.code === listing.defaultLocaleCode);
  const dir = locale?.textDirection === 'rtl' ? 'rtl' : 'ltr';
  return (
    <>
      <p>
        <strong>{e('defaultLanguage', { language: locale?.name ?? listing.defaultLocaleCode })}</strong>
      </p>
      <TextField id={idOf('title')} label={e('titleField')} value={form.title} onChange={(value) => set('title', value)} isRequired maxLength={200} lang={listing.defaultLocaleCode} dir={dir} error={errors['title']} />
      <TextField
        id={idOf('description')}
        label={e('descriptionField')}
        value={form.description}
        onChange={(value) => set('description', value)}
        multiline
        maxLength={10000}
        lang={listing.defaultLocaleCode}
        dir={dir}
        error={errors['description']}
      />
    </>
  );
}

/** Translations side by side (tabs collapse to a stack on narrow screens); each language saves on its own. */
export function TranslationEditor({ listing, readOnly = false }: { listing: ListingDto; readOnly?: boolean }) {
  const e = useTranslations('listings.edit');
  const locales = useLocales();
  const [adding, setAdding] = useState<string | null>(null);
  const used = new Set([listing.defaultLocaleCode, ...listing.translations.map((translation) => translation.localeCode)]);
  const available = (locales.data?.data ?? []).filter((locale) => !used.has(locale.code));
  const rows: TranslationDto[] = [...listing.translations];
  if (adding && !used.has(adding)) rows.push({ localeCode: adding, title: '', description: null, source: 'manual', updatedAt: '' });
  return (
    <Panel title={e('text')}>
      <div className={styles.translations}>
        {rows.map((translation) => (
          <TranslationCard
            key={translation.localeCode}
            listing={listing}
            translation={translation}
            language={locales.data?.data.find((locale) => locale.code === translation.localeCode)}
            readOnly={readOnly}
            onDone={() => setAdding(null)}
          />
        ))}
      </div>
      {readOnly || available.length === 0 ? null : (
        <SelectField label={e('addLanguage')} value={adding} onChange={setAdding} placeholder={e('chooseLanguage')} options={available.map((locale) => ({ id: locale.code, label: locale.name }))} />
      )}
    </Panel>
  );
}

function TranslationCard({
  listing,
  translation,
  language,
  readOnly,
  onDone,
}: {
  listing: ListingDto;
  translation: TranslationDto;
  language: { code: string; name: string; textDirection: 'ltr' | 'rtl' } | undefined;
  readOnly: boolean;
  onDone: () => void;
}) {
  const e = useTranslations('listings.edit');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [title, setTitle] = useState(translation.title);
  const [description, setDescription] = useState(translation.description ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    setTitle(translation.title);
    setDescription(translation.description ?? '');
  }, [translation]);
  const name = language?.name ?? translation.localeCode;
  const dir = language?.textDirection ?? 'ltr';
  const lang = translation.localeCode;
  const exists = translation.updatedAt !== '';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`listings/${listing.id}/translations/${lang}`, { method: 'PUT', version: listing.version, body: { title: title.trim(), description: description.trim() || null } });
      announce(e('translationSaved', { language: name }));
      await refresh();
      onDone();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await bffRequest(`listings/${listing.id}/translations/${lang}`, { method: 'DELETE', version: listing.version });
      announce(e('translationRemoved', { language: name }));
      setRemoving(false);
      await refresh();
    } catch (caught) {
      setError(caught);
      setRemoving(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={name} lang={lang} dir={dir} className={formClass}>
      <h3 lang={undefined}>{name}</h3>
      {error ? <FormProblem error={error} fields={{}} /> : null}
      <TextField label={e('titleField')} value={title} onChange={setTitle} isRequired maxLength={200} lang={lang} dir={dir} isDisabled={readOnly} error={fieldErrorsOf(error)['title']} />
      <TextField label={e('descriptionField')} value={description} onChange={setDescription} multiline maxLength={10000} lang={lang} dir={dir} isDisabled={readOnly} error={fieldErrorsOf(error)['description']} />
      {readOnly ? null : (
        <Cluster>
          <Button variant="primary" onPress={() => void save()} busy={busy} isDisabled={title.trim() === ''}>
            {e('saveTranslation', { language: name })}
          </Button>
          {exists ? (
            <Button variant="quiet" onPress={() => setRemoving(true)}>
              {e('removeLanguage', { language: name })}
            </Button>
          ) : null}
        </Cluster>
      )}
      <ConfirmDialog
        isOpen={removing}
        onOpenChange={setRemoving}
        title={e('removeTitle', { language: name })}
        consequence={e('removeConsequence', { language: name })}
        confirmLabel={e('removeLanguage', { language: name })}
        danger
        busy={busy}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
