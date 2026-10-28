'use client';

import { useLocale, useTranslations } from 'next-intl';

import { FieldRow, TextField } from '@/components/ui/fields';
import type { CountryDto } from '@/lib/api-schema';

export interface AddressValue {
  addressLine1: string;
  addressLine2: string;
  dependentLocality: string;
  locality: string;
  adminArea2: string;
  adminArea1: string;
  postalCode: string;
  localComponents: Record<string, string>;
}

interface FieldRule {
  label?: string;
  required?: boolean;
  hidden?: boolean;
  pattern?: string;
}

interface AddressFormat {
  locality?: FieldRule;
  admin_area_1?: FieldRule;
  admin_area_2?: FieldRule;
  postal_code?: FieldRule;
  local_components?: Array<FieldRule & { key: string; label: string }>;
}

export const EMPTY_ADDRESS: AddressValue = { addressLine1: '', addressLine2: '', dependentLocality: '', locality: '', adminArea2: '', adminArea1: '', postalCode: '', localComponents: {} };

const FORMAT_KEYS = { locality: 'locality', adminArea1: 'admin_area_1', adminArea2: 'admin_area_2', postalCode: 'postal_code' } as const;

/** Field ids for the validation summary, keyed by API field path. */
export function addressFieldIds(prefix: string, country: CountryDto | undefined): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const key of ['addressLine1', 'addressLine2', 'dependentLocality', 'locality', 'adminArea2', 'adminArea1', 'postalCode']) ids[`address.${key}`] = `${prefix}-${key}`;
  for (const component of (country?.addressFormat as AddressFormat | undefined)?.local_components ?? []) ids[`address.localComponents.${component.key}`] = `${prefix}-lc-${component.key}`;
  return ids;
}

/**
 * AddressFields (P-3): the fields, labels, required flags and patterns of the
 * country's address format (A-9). English uses the country's own labels;
 * other languages use the translated generic labels.
 */
export function AddressFields({
  country,
  value,
  onChange,
  errors,
  idPrefix,
}: {
  country: CountryDto | undefined;
  value: AddressValue;
  onChange: (value: AddressValue) => void;
  errors: Record<string, string>;
  idPrefix: string;
}) {
  const t = useTranslations('properties.addressField');
  const local = useTranslations('properties.localComponent');
  const language = useLocale();
  const format = (country?.addressFormat ?? {}) as AddressFormat;
  const rule = (key: keyof typeof FORMAT_KEYS): FieldRule => format[FORMAT_KEYS[key]] ?? {};
  const label = (key: Exclude<keyof AddressValue, 'localComponents'>, formatRule?: FieldRule) => (language === 'en' && formatRule?.label ? formatRule.label : t(key));
  const set = (key: keyof Omit<AddressValue, 'localComponents'>) => (next: string) => onChange({ ...value, [key]: next });
  const field = (key: keyof typeof FORMAT_KEYS) =>
    rule(key).hidden ? null : (
      <TextField
        id={`${idPrefix}-${key}`}
        label={label(key, rule(key))}
        value={value[key]}
        onChange={set(key)}
        isRequired={rule(key).required === true}
        error={errors[`address.${key}`]}
        dir="auto"
        maxLength={200}
      />
    );

  return (
    <>
      <TextField
        id={`${idPrefix}-addressLine1`}
        label={t('addressLine1')}
        value={value.addressLine1}
        onChange={set('addressLine1')}
        error={errors['address.addressLine1']}
        autoComplete="address-line1"
        dir="auto"
        maxLength={200}
      />
      <TextField id={`${idPrefix}-addressLine2`} label={t('addressLine2')} value={value.addressLine2} onChange={set('addressLine2')} error={errors['address.addressLine2']} dir="auto" maxLength={200} />
      <FieldRow>
        <TextField
          id={`${idPrefix}-dependentLocality`}
          label={t('dependentLocality')}
          value={value.dependentLocality}
          onChange={set('dependentLocality')}
          error={errors['address.dependentLocality']}
          dir="auto"
          maxLength={120}
        />
        {field('locality')}
      </FieldRow>
      <FieldRow>
        {field('adminArea2')}
        {field('adminArea1')}
      </FieldRow>
      {field('postalCode')}
      {(format.local_components ?? []).map((component) => (
        <TextField
          key={component.key}
          id={`${idPrefix}-lc-${component.key}`}
          label={language !== 'en' && local.has(component.key) ? local(component.key) : component.label}
          value={value.localComponents[component.key] ?? ''}
          onChange={(next) => onChange({ ...value, localComponents: { ...value.localComponents, [component.key]: next } })}
          isRequired={component.required === true}
          error={errors[`address.localComponents.${component.key}`]}
          dir="ltr"
          maxLength={60}
        />
      ))}
    </>
  );
}
