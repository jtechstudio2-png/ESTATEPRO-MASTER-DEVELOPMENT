'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { Checkbox, FieldRow, SegmentedControl, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass, Page, PageHeader } from '@/components/ui/layout';
import { FilterSelect, listStyles } from '@/components/ui/list-controls';
import type { CreatePropertyTypeBody, PropertyTypeDto, UpdatePropertyTypeBody } from '@/lib/api-schema';
import { bffRequest, newIdempotencyKey } from '@/lib/bff';
import { useListParams } from '@/lib/hooks/list-params';
import { useCountries, usePropertyTypes } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import tableStyles from '@/components/ui/table.module.css';

const USAGE = ['residential', 'commercial', 'industrial', 'land', 'mixed_use', 'hospitality', 'agricultural', 'other'] as const;
const APPLIES = ['property', 'unit', 'both'] as const;
const ALL = '__all__';

/** P-7: platform types (read-only) and the company's own types (settings.manage). */
export function PropertyTypesSettings() {
  const t = useTranslations('properties.types');
  const enums = useTranslations('enums');
  const common = useTranslations('common');
  const { can, readOnly } = useSession();
  const params = useListParams();
  const countries = useCountries();
  const country = params.get('filter[countryCode]');
  const source = params.get('source') ?? 'all';
  const types = usePropertyTypes({ countryCode: country ?? undefined });
  const [editing, setEditing] = useState<PropertyTypeDto | 'new' | null>(null);
  const manage = can('settings.manage') && !readOnly;

  const rows = (types.data?.data ?? []).filter((type) => source === 'all' || (source === 'company') === type.isCompanyDefined);
  const countryName = (code: string | null) => (code === null ? t('allCountries') : t('countryOnly', { country: countries.data?.data.find((item) => item.code === code)?.name ?? code }));

  return (
    <Page>
      <PageHeader
        title={t('title')}
        subtitle={manage ? undefined : t('readOnlyNote')}
        actions={
          manage ? (
            <Button variant="primary" onPress={() => setEditing('new')}>
              {t('add')}
            </Button>
          ) : undefined
        }
      />
      <div className={listStyles.toolbar}>
        <SegmentedControl
          label={t('source')}
          value={source}
          onChange={(value) => params.set({ source: value === 'all' ? null : value })}
          options={[
            { id: 'all', label: t('all') },
            { id: 'platform', label: t('platform') },
            { id: 'company', label: t('company') },
          ]}
        />
        <FilterSelect label={common('country')} value={country} onChange={(value) => params.set({ 'filter[countryCode]': value })} options={(countries.data?.data ?? []).map((item) => ({ id: item.code, label: item.name }))} />
      </div>
      {types.isPending ? (
        <div aria-busy="true">
          <Skeleton />
          <Skeleton />
        </div>
      ) : types.isError ? (
        <ErrorNotice error={types.error} onRetry={() => void types.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={source === 'company' ? t('emptyCompany') : t('list')} />
      ) : (
        <div className={tableStyles.region} role="region" aria-label={t('list')} tabIndex={0}>
          <table className={tableStyles.table}>
            <caption className="ep-visually-hidden">{t('list')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('name')}</th>
                <th scope="col">{t('code')}</th>
                <th scope="col">{t('appliesTo')}</th>
                <th scope="col">{t('usageClass')}</th>
                <th scope="col">{common('country')}</th>
                <th scope="col">{t('active')}</th>
                <th scope="col">
                  <span className="ep-visually-hidden">{common('actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((type) => (
                <tr key={type.id}>
                  <th scope="row">
                    <bdi>{type.name}</bdi>
                    <span className={tableStyles.secondary}>{type.isCompanyDefined ? t('company') : t('platformRow')}</span>
                  </th>
                  <td>
                    <code dir="ltr">{type.code}</code>
                  </td>
                  <td>{enums(`appliesTo.${type.appliesTo}`)}</td>
                  <td>{enums(`usageClass.${type.usageClass}`)}</td>
                  <td>{countryName(type.countryCode)}</td>
                  <td>{type.isActive ? <StatusLabel tone="success">{t('active')}</StatusLabel> : <StatusLabel tone="neutral">{common('archived')}</StatusLabel>}</td>
                  <td>
                    {manage && type.isCompanyDefined ? (
                      <Button size="small" onPress={() => setEditing(type)} aria-label={`${common('edit')} ${type.name}`}>
                        {common('edit')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <PropertyTypeDialog type={editing === 'new' ? null : editing} parents={types.data?.data ?? []} onClose={() => setEditing(null)} /> : null}
    </Page>
  );
}

function PropertyTypeDialog({ type, parents, onClose }: { type: PropertyTypeDto | null; parents: PropertyTypeDto[]; onClose: () => void }) {
  const t = useTranslations('properties.types');
  const enums = useTranslations('enums');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const countries = useCountries();
  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    usageClass: type?.usageClass ?? 'residential',
    appliesTo: type?.appliesTo ?? 'property',
    parentId: type?.parentId ?? ALL,
    countryCode: type?.countryCode ?? ALL,
    sortOrder: String(type?.sortOrder ?? 100),
    isActive: type?.isActive ?? true,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const prefix = useId();
  const fieldErrors = fieldErrorsOf(error);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (type) {
        const body: UpdatePropertyTypeBody = { name: form.name.trim(), isActive: form.isActive, sortOrder: Number(form.sortOrder) };
        await bffRequest(`property-types/${type.id}`, { method: 'PATCH', version: type.version, body });
      } else {
        const body: CreatePropertyTypeBody = {
          code: form.code.trim(),
          name: form.name.trim(),
          usageClass: form.usageClass,
          appliesTo: form.appliesTo,
          sortOrder: Number(form.sortOrder),
          ...(form.parentId === ALL ? {} : { parentId: form.parentId }),
          ...(form.countryCode === ALL ? {} : { countryCode: form.countryCode }),
        };
        await bffRequest('property-types', { method: 'POST', idempotencyKey, body });
      }
      announce(t('saved', { name: form.name.trim() }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const ids = { code: `${prefix}-code`, name: `${prefix}-name`, sortOrder: `${prefix}-sort` };
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={type ? t('editTitle', { name: type.name }) : t('addTitle')}
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
        <FormProblem error={error} fields={{ code: { label: t('code'), id: ids.code }, name: { label: t('name'), id: ids.name }, sortOrder: { label: t('sortOrder'), id: ids.sortOrder } }} />
        {type ? (
          <Notice tone="info">
            <code dir="ltr">{type.code}</code> · {enums(`appliesTo.${type.appliesTo}`)} · {enums(`usageClass.${type.usageClass}`)}
          </Notice>
        ) : (
          <TextField id={ids.code} label={t('code')} value={form.code} onChange={(value) => set('code', value)} isRequired description={t('codeHint')} dir="ltr" maxLength={60} error={fieldErrors['code']} />
        )}
        <TextField id={ids.name} label={t('name')} value={form.name} onChange={(value) => set('name', value)} isRequired dir="auto" maxLength={120} error={fieldErrors['name']} />
        {type ? null : (
          <>
            <FieldRow>
              <SelectField label={t('usageClass')} value={form.usageClass} onChange={(value) => set('usageClass', value as (typeof USAGE)[number])} options={USAGE.map((id) => ({ id, label: enums(`usageClass.${id}`) }))} />
              <SelectField label={t('appliesTo')} value={form.appliesTo} onChange={(value) => set('appliesTo', value as (typeof APPLIES)[number])} options={APPLIES.map((id) => ({ id, label: enums(`appliesTo.${id}`) }))} />
            </FieldRow>
            <FieldRow>
              <SelectField
                label={t('parent')}
                value={form.parentId}
                onChange={(value) => set('parentId', value)}
                options={[{ id: ALL, label: common('none') }, ...parents.filter((parent) => parent.parentId === null).map((parent) => ({ id: parent.id, label: parent.name }))]}
              />
              <SelectField
                label={common('country')}
                value={form.countryCode}
                onChange={(value) => set('countryCode', value)}
                options={[{ id: ALL, label: t('allCountries') }, ...(countries.data?.data ?? []).map((item) => ({ id: item.code, label: item.name }))]}
              />
            </FieldRow>
          </>
        )}
        <TextField id={ids.sortOrder} label={t('sortOrder')} value={form.sortOrder} onChange={(value) => set('sortOrder', value)} inputMode="numeric" error={fieldErrors['sortOrder']} />
        {type ? (
          <Checkbox isSelected={form.isActive} onChange={(value) => set('isActive', value)}>
            {t('active')}
          </Checkbox>
        ) : null}
      </form>
    </Dialog>
  );
}
