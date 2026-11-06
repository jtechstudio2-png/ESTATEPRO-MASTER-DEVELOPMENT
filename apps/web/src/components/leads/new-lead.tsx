'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { ComboBox, FieldError, Input, Label, ListBox, ListBoxItem, Popover, Text } from 'react-aria-components';

import { useAnnounce } from '@/components/announcer';
import { DuplicatePanel, useDuplicateCheck } from '@/components/contacts/duplicates';
import { type ContactRole, LEAD_TYPES, Ltr } from '@/components/crm/labels';
import { useContact } from '@/components/crm/use-crm';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import fieldStyles from '@/components/ui/field.module.css';
import { FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass, Page, PageHeader, Panel } from '@/components/ui/layout';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-guard';
import type { ContactPageDto, ContactSummaryDto, CreateLeadBody, LeadDto, ListingListItemDto } from '@/lib/api-schema';
import { bff, newIdempotencyKey, query } from '@/lib/bff';
import { useOffices, usePicklist } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';

const NONE = '__none__';

/** The role a new contact takes from the lead that brings them in (L-3). */
function roleForLead(leadType: CreateLeadBody['leadType']): ContactRole[] {
  switch (leadType) {
    case 'rent':
      return ['applicant'];
    case 'buy':
      return ['buyer'];
    case 'sell':
    case 'valuation':
      return ['seller'];
    case 'let':
    case 'management':
      return ['landlord'];
    default:
      return [];
  }
}

/** Contact search: name, phone in any format, or reference, in the member's own scope (lead capture, privacy requests). */
export function ContactSearch({
  value,
  onChange,
  error,
  labelId,
  label,
  help,
}: {
  value: ContactSummaryDto | null;
  onChange: (contact: ContactSummaryDto | null) => void;
  error?: string;
  labelId: string;
  label?: string;
  help?: string;
}) {
  const t = useTranslations('leads');
  const form = useTranslations('form');
  const [text, setText] = useState(value?.displayName ?? '');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const trimmed = text.trim();
    if (value && trimmed === value.displayName) return;
    const timer = setTimeout(() => setTerm(trimmed.length >= 2 ? trimmed : ''), 300);
    return () => clearTimeout(timer);
  }, [text, value]);
  const results = useQuery({ queryKey: ['list', 'lead-contact-search', term], queryFn: () => bff<ContactPageDto>(`contacts${query({ q: term, limit: 10 })}`), enabled: term !== '' });
  const items = results.data?.data ?? [];
  return (
    <ComboBox
      className={fieldStyles.field}
      defaultInputValue={value?.displayName ?? ''}
      onInputChange={setText}
      selectedKey={value?.id ?? null}
      onSelectionChange={(key) => onChange(items.find((item) => item.id === key) ?? null)}
      items={items}
      allowsEmptyCollection
      isInvalid={error !== undefined}
      validationBehavior="aria"
    >
      <Label className={fieldStyles.label} id={labelId}>
        {label ?? t('existingContact')}
      </Label>
      <Input className={fieldStyles.input} dir="auto" />
      <Text slot="description" className={fieldStyles.description}>
        {help ?? t('existingContactHelp')}
      </Text>
      <FieldError className={fieldStyles.error}>{error}</FieldError>
      <Popover className={fieldStyles.popover}>
        <ListBox className={fieldStyles.listbox} renderEmptyState={() => <p className={fieldStyles.description}>{results.isFetching ? form('searching') : form('noMatches')}</p>}>
          {(item: ContactSummaryDto) => (
            <ListBoxItem id={item.id} className={fieldStyles.option} textValue={item.displayName}>
              <bdi dir="auto">{item.displayName}</bdi> {item.primaryPhoneMasked ? <Ltr>{item.primaryPhoneMasked}</Ltr> : null} {item.reference ? <Ltr>{item.reference}</Ltr> : null}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}

/**
 * L-3 new lead (quick capture): an existing contact, or a new one typed in
 * place (runs the C-3 duplicate check; needs `contact.create`). The phone
 * typed here is carried into the new contact (WCAG 3.3.7 redundant entry).
 * Members without `lead.assign` capture leads for themselves.
 */
export function NewLead() {
  const t = useTranslations('leads');
  const crm = useTranslations('crm');
  const common = useTranslations('common');
  const router = useRouter();
  const search = useSearchParams();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { can } = useSession();
  const { offices } = useOffices('lead.view');
  const sources = usePicklist('lead_source');
  const duplicates = useDuplicateCheck();
  const presetContactId = search.get('contactId');
  const preset = useContact(presetContactId ?? '', presetContactId !== null);
  const canCreateContact = can('contact.create');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [contact, setContact] = useState<ContactSummaryDto | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [leadType, setLeadType] = useState<CreateLeadBody['leadType']>('buy');
  const [sourceCode, setSourceCode] = useState<string>(NONE);
  const [detail, setDetail] = useState('');
  const [listingTerm, setListingTerm] = useState('');
  const [listingId, setListingId] = useState<string>(NONE);
  const [message, setMessage] = useState('');
  const [assignee, setAssignee] = useState<PickedMember | null>(null);
  const [officeId, setOfficeId] = useState<string>(NONE);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const ids = { contact: useId(), name: useId(), phone: useId(), source: useId(), office: useId() };
  const listings = useQuery({
    queryKey: ['list', 'lead-listing-search', listingTerm],
    queryFn: () => bff<{ data: ListingListItemDto[] }>(`listings${query({ q: listingTerm, 'filter[isPublished]': 'true', limit: 10 })}`),
    enabled: listingTerm.trim().length >= 2 && can('listing.view'),
  });
  const presetContact = presetContactId && preset.data ? preset.data : null;
  const touched = () => setDirty(true);

  const submit = async () => {
    const errors: Record<string, string> = {};
    if (!presetContact && mode === 'existing' && contact === null) errors['contactId'] = t('contactRequired');
    if (!presetContact && mode === 'new') {
      if (name.trim() === '') errors['contact.displayName'] = t('nameRequired');
      if (phone.trim() === '' && email.trim() === '') errors['contact.primaryPhone'] = t('phoneOrEmail');
    }
    if (sourceCode === NONE) errors['sourceCode'] = t('sourceRequired');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    const contactPart = presetContact
      ? { contactId: presetContact.id }
      : mode === 'existing'
        ? { contactId: contact!.id }
        : {
            contact: {
              contactType: 'person' as const,
              displayName: name.trim(),
              ...(phone.trim() ? { primaryPhone: phone.trim() } : {}),
              ...(email.trim() ? { primaryEmail: email.trim() } : {}),
              sourceCode,
              relationships: roleForLead(leadType),
              ...(duplicates.confirmed ? { confirmNotDuplicate: true } : {}),
            },
          };
    const body: CreateLeadBody = {
      ...contactPart,
      leadType,
      sourceCode,
      ...(detail.trim() ? { sourceDetail: detail.trim() } : {}),
      ...(listingId !== NONE ? { listingId } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
      ...(assignee ? { assignedTo: assignee.membershipId } : {}),
      ...(officeId !== NONE ? { officeId } : {}),
    };
    try {
      const created = await bff<LeadDto>('leads', { method: 'POST', body, idempotencyKey: key });
      announce(t('createdLead', { reference: created.reference }));
      await refresh();
      setDirty(false);
      router.push(`/leads/${created.id}`);
    } catch (caught) {
      if (!duplicates.fromError(caught)) setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (field: string) => clientErrors[field] ?? fieldErrorsOf(error)[field];
  return (
    <Page>
      <UnsavedChangesGuard dirty={dirty && !busy} />
      <PageHeader title={t('newTitle')} back={{ href: '/leads', label: t('backToList') }} />
      <form
        className={formClass}
        noValidate
        onChange={touched}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormProblem
          error={error}
          clientErrors={clientErrors}
          fields={{
            contactId: { label: t('existingContact'), id: ids.contact },
            'contact.displayName': { label: t('contactName'), id: ids.name },
            'contact.primaryPhone': { label: t('contactPhone'), id: ids.phone },
            sourceCode: { label: t('source'), id: ids.source },
            officeId: { label: t('office'), id: ids.office },
          }}
        />
        <Panel title={t('contactSection')}>
          {presetContact ? (
            <p>{t('forContact', { name: presetContact.displayName })}</p>
          ) : (
            <>
              {canCreateContact ? (
                <RadioGroupField
                  label={t('contactMode')}
                  value={mode}
                  onChange={(value) => setMode(value as 'existing' | 'new')}
                  options={[
                    { id: 'existing', label: t('modeExisting') },
                    { id: 'new', label: t('modeNew') },
                  ]}
                />
              ) : null}
              {mode === 'existing' ? (
                <ContactSearch value={contact} onChange={setContact} labelId={ids.contact} error={fieldError('contactId')} />
              ) : (
                <>
                  <TextField id={ids.name} label={t('contactName')} value={name} onChange={setName} isRequired dir="auto" maxLength={200} error={fieldError('contact.displayName')} />
                  <div onBlur={() => void duplicates.check({ primaryPhone: phone, primaryEmail: email, officeId: officeId === NONE ? null : officeId })}>
                    <FieldRow>
                      <TextField id={ids.phone} label={t('contactPhone')} description={t('phoneHelp')} type="tel" inputMode="tel" value={phone} onChange={setPhone} dir="ltr" maxLength={40} error={fieldError('contact.primaryPhone')} />
                      <TextField label={t('contactEmail')} type="email" inputMode="email" value={email} onChange={setEmail} dir="ltr" maxLength={320} error={fieldError('contact.primaryEmail')} />
                    </FieldRow>
                  </div>
                  <DuplicatePanel candidates={duplicates.candidates} confirmed={duplicates.confirmed} onConfirm={duplicates.confirm} />
                </>
              )}
            </>
          )}
        </Panel>
        <Panel title={t('enquirySection')}>
          <FieldRow>
            <SelectField label={t('type')} value={leadType} onChange={(value) => setLeadType(value as CreateLeadBody['leadType'])} isRequired options={LEAD_TYPES.map((id) => ({ id, label: crm(`leadType.${id}`) }))} />
            <SelectField
              id={ids.source}
              label={t('source')}
              value={sourceCode}
              onChange={setSourceCode}
              isRequired
              options={[{ id: NONE, label: t('chooseSource') }, ...(sources.data?.data ?? []).map((value) => ({ id: value.code, label: value.label }))]}
              error={fieldError('sourceCode')}
            />
            <TextField label={t('sourceDetail')} value={detail} onChange={setDetail} maxLength={200} dir="auto" />
          </FieldRow>
          {can('listing.view') ? (
            <FieldRow>
              <TextField label={t('listingSearch')} description={t('listingSearchHelp')} value={listingTerm} onChange={setListingTerm} dir="auto" />
              <SelectField
                label={t('listing')}
                value={listingId}
                onChange={setListingId}
                options={[{ id: NONE, label: t('generalEnquiry') }, ...(listings.data?.data ?? []).map((listing) => ({ id: listing.id, label: `${listing.reference} · ${listing.title}` }))]}
              />
            </FieldRow>
          ) : null}
          <TextField label={t('message')} description={t('messageHelp')} value={message} onChange={setMessage} multiline maxLength={5000} dir="auto" />
        </Panel>
        <Panel title={t('routingSection')}>
          <FieldRow>
            {can('lead.assign') ? (
              <PeoplePicker label={t('assignTo')} description={t('assignToHelp')} value={assignee} onChange={setAssignee} permission="lead.view" {...(officeId !== NONE ? { officeId } : {})} />
            ) : (
              <p>{t('assignedToYou')}</p>
            )}
            {offices.length > 1 ? (
              <SelectField id={ids.office} label={t('office')} value={officeId} onChange={setOfficeId} options={[{ id: NONE, label: t('defaultOffice') }, ...offices.map((office) => ({ id: office.id, label: office.name }))]} error={fieldError('officeId')} />
            ) : null}
          </FieldRow>
        </Panel>
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            {t('create')}
          </Button>{' '}
          <LinkButton href="/leads">{common('cancel')}</LinkButton>
        </div>
      </form>
    </Page>
  );
}
