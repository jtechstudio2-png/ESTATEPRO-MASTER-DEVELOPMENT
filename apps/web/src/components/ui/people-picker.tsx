'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { Button as AriaButton, ComboBox, FieldError, Input, Label, ListBox, ListBoxItem, Popover, Text } from 'react-aria-components';

import { bff, query } from '@/lib/bff';
import type { MemberListDto } from '@/lib/api-schema';

import styles from './field.module.css';

export interface PickedMember {
  membershipId: string;
  displayName: string;
}

interface PeoplePickerProps {
  label: ReactNode;
  value: PickedMember | null;
  onChange: (member: PickedMember | null) => void;
  /** Only members whose role grants this permission (and office) are offered (A-2). */
  permission?: string;
  officeId?: string;
  error?: string;
  description?: ReactNode;
  isRequired?: boolean;
}

/**
 * Staff picker (A-2): names only, searched by the API as the user types.
 * Never lists contact details.
 */
export function PeoplePicker({ label, value, onChange, permission, officeId, error, description, isRequired }: PeoplePickerProps) {
  const t = useTranslations('form');
  const [text, setText] = useState(value?.displayName ?? '');
  const [term, setTerm] = useState('');
  useEffect(() => setText(value?.displayName ?? ''), [value]);
  useEffect(() => {
    const trimmed = text.trim();
    const timer = setTimeout(() => setTerm(trimmed.length >= 2 && trimmed !== value?.displayName ? trimmed : ''), 300);
    return () => clearTimeout(timer);
  }, [text, value]);
  const members = useQuery({
    queryKey: ['members', term, permission, officeId],
    queryFn: ({ signal }) =>
      bff<MemberListDto>(`members${query({ q: term || undefined, 'filter[permission]': permission, 'filter[officeId]': permission ? officeId : undefined })}`, { signal }),
    staleTime: 60_000,
  });
  const items = members.data?.data ?? [];
  return (
    <ComboBox
      className={styles.field}
      inputValue={text}
      onInputChange={setText}
      selectedKey={value?.membershipId ?? null}
      onSelectionChange={(key) => {
        const picked = items.find((item) => item.membershipId === key) ?? null;
        onChange(picked ? { membershipId: picked.membershipId, displayName: picked.displayName } : null);
      }}
      items={items}
      allowsEmptyCollection
      menuTrigger="focus"
      isRequired={isRequired}
      isInvalid={error !== undefined}
      validationBehavior="aria"
    >
      <Label className={styles.label}>
        {label}
        {isRequired ? <span className={styles.required}>({t('required')})</span> : null}
      </Label>
      <div className={styles.comboRow}>
        <Input className={styles.input} />
        <AriaButton className={styles.comboButton} aria-label={t('showOptions')}>
          <span aria-hidden="true">▾</span>
        </AriaButton>
      </div>
      {description ? (
        <Text slot="description" className={styles.description}>
          {description}
        </Text>
      ) : null}
      <FieldError className={styles.error}>{error}</FieldError>
      <Popover className={styles.popover}>
        <ListBox className={styles.listbox} renderEmptyState={() => <p className={styles.description}>{members.isPending ? t('searching') : t('noMatches')}</p>}>
          {(item: MemberListDto['data'][number]) => (
            <ListBoxItem id={item.membershipId} className={styles.option} textValue={item.displayName}>
              <bdi>{item.displayName}</bdi> <span className={styles.description}>· {item.roleName}</span>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
