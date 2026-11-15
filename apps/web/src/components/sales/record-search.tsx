'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { ComboBox, FieldError, Input, Label, ListBox, ListBoxItem, Popover, Text } from 'react-aria-components';

import { Ltr } from '@/components/crm/labels';
import fieldStyles from '@/components/ui/field.module.css';
import type { DealSummaryPageDto, ListingListItemDto, ListingPageDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';

interface Picked {
  id: string;
  label: string;
}

interface SearchProps<T extends { id: string }> {
  label: ReactNode;
  help?: ReactNode;
  value: Picked | null;
  onChange: (item: T | null) => void;
  error?: string | undefined;
  labelId?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  queryKey: string;
  fetch: (term: string) => Promise<T[]>;
  textOf: (item: T) => string;
  render: (item: T) => ReactNode;
}

/** A type-ahead search over one register, within the member's own scope (the API decides what is found). */
function RecordSearch<T extends { id: string }>({ label, help, value, onChange, error, labelId, isRequired, isDisabled, queryKey, fetch, textOf, render }: SearchProps<T>) {
  const form = useTranslations('form');
  const [text, setText] = useState(value?.label ?? '');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const trimmed = text.trim();
    if (value && trimmed === value.label) return;
    const timer = setTimeout(() => setTerm(trimmed.length >= 2 ? trimmed : ''), 300);
    return () => clearTimeout(timer);
  }, [text, value]);
  const results = useQuery({ queryKey: ['list', queryKey, term], queryFn: () => fetch(term), enabled: term !== '' });
  const items = results.data ?? [];
  return (
    <ComboBox
      className={fieldStyles.field}
      defaultInputValue={value?.label ?? ''}
      onInputChange={setText}
      selectedKey={value?.id ?? null}
      onSelectionChange={(key) => onChange(items.find((item) => item.id === key) ?? null)}
      items={items}
      allowsEmptyCollection
      isInvalid={error !== undefined}
      isRequired={isRequired ?? false}
      isDisabled={isDisabled ?? false}
      validationBehavior="aria"
    >
      <Label className={fieldStyles.label} {...(labelId ? { id: labelId } : {})}>
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <Input className={fieldStyles.input} dir="auto" />
      {help ? (
        <Text slot="description" className={fieldStyles.description}>
          {help}
        </Text>
      ) : null}
      <FieldError className={fieldStyles.error}>{error}</FieldError>
      <Popover className={fieldStyles.popover}>
        <ListBox className={fieldStyles.listbox} renderEmptyState={() => <p className={fieldStyles.description}>{results.isFetching ? form('searching') : form('noMatches')}</p>}>
          {(item: T) => (
            <ListBoxItem id={item.id} className={fieldStyles.option} textValue={textOf(item)}>
              {render(item)}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}

/** Live listings only by default (V-2, DL-2): available, reserved or under contract. */
export function ListingSearch({
  listingType,
  statuses = 'available,reserved,under_contract',
  ...props
}: Omit<SearchProps<ListingListItemDto>, 'queryKey' | 'fetch' | 'textOf' | 'render'> & { listingType?: 'sale' | 'rent'; statuses?: string }) {
  return (
    <RecordSearch<ListingListItemDto>
      {...props}
      queryKey={`sales-listing-search-${listingType ?? 'any'}-${statuses}`}
      fetch={async (term) => (await bff<ListingPageDto>(`listings${query({ q: term, 'filter[status]': statuses, 'filter[listingType]': listingType, limit: 10 })}`)).data}
      textOf={(item) => `${item.reference} ${item.title}`}
      render={(item) => (
        <>
          <Ltr>{item.reference}</Ltr> <bdi dir="auto">{item.title}</bdi>
        </>
      )}
    />
  );
}

/** Open deals in scope, by reference or contact (V-2 "for a deal"). */
export function DealSearch(props: Omit<SearchProps<{ id: string; reference: string; primaryContact: { name: string } }>, 'queryKey' | 'fetch' | 'textOf' | 'render'>) {
  return (
    <RecordSearch
      {...props}
      queryKey="sales-deal-search"
      fetch={async (term) => (await bff<DealSummaryPageDto>(`deals${query({ q: term, 'filter[status]': 'open', limit: 10 })}`)).data}
      textOf={(item) => `${item.reference} ${item.primaryContact.name}`}
      render={(item) => (
        <>
          <Ltr>{item.reference}</Ltr> <bdi dir="auto">{item.primaryContact.name}</bdi>
        </>
      )}
    />
  );
}
