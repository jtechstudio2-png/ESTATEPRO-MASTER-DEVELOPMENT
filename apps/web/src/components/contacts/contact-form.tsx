'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { CONTACT_ROLES, type ContactRole } from '@/components/crm/labels';
import { useContact } from '@/components/crm/use-crm';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Checkbox, FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Fieldset, formClass, Page, PageHeader, Panel } from '@/components/ui/layout';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-guard';
import type { ConsentInput, ContactDto, CreateContactBody, UpdateContactBody } from '@/lib/api-schema';
import { bffRequest, newIdempotencyKey } from '@/lib/bff';
import { useCountries, useLocales, useOffices, usePicklist } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { DuplicatePanel, useDuplicateCheck } from './duplicates';

const CHANNELS = ['whatsapp', 'phone', 'sms', 'email', 'post'] as const;
const CONSENT_CHANNELS = ['whatsapp', 'sms', 'email', 'phone'] as const;
type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
const NONE = '__none__';

interface FormState {
  contactType: 'person' | 'organisation';
  displayName: string;
  displayNameLocal: string;
  title: string;
  givenName: string;
  familyName: string;
  otherNames: string;
  organisationName: string;
  primaryPhone: string;
  primaryEmail: string;
  preferredChannel: string;
  preferredLocaleCode: string;
  sourceCode: string;
  officeId: string;
  nationalityCountryCode: string;
  residenceCountryCode: string;
  notes: string;
  /** Protected values (ADR-007): entered here, never shown back after saving. */
  dateOfBirth: string;
  taxNumber: string;
  organisationRegNumber: string;
}

function initial(contact: ContactDto | null): FormState {
  return {
    contactType: contact?.contactType ?? 'person',
    displayName: contact?.displayName ?? '',
    displayNameLocal: contact?.displayNameLocal ?? '',
    title: contact?.title ?? '',
    givenName: contact?.givenName ?? '',
    familyName: contact?.familyName ?? '',
    otherNames: contact?.otherNames ?? '',
    organisationName: contact?.organisationName ?? '',
    primaryPhone: contact?.primaryPhone ?? '',
    primaryEmail: contact?.primaryEmail ?? '',
    preferredChannel: contact?.preferredChannel ?? NONE,
    preferredLocaleCode: contact?.preferredLocaleCode ?? NONE,
    sourceCode: contact?.sourceCode ?? NONE,
    officeId: contact?.office?.id ?? NONE,
    nationalityCountryCode: contact?.nationalityCountryCode ?? NONE,
    residenceCountryCode: contact?.residenceCountryCode ?? NONE,
    notes: contact?.notes ?? '',
    dateOfBirth: '',
    taxNumber: '',
    organisationRegNumber: '',
  };
}

const orNull = (value: string) => (value.trim() === '' || value === NONE ? null : value.trim());

/** The contact form for creating (`/contacts/new`) or editing (`/contacts/{id}/edit`). */
export function ContactFormPage({ id }: { id?: string }) {
  const t = useTranslations('contacts');
  const contact = useContact(id ?? '', id !== undefined);
  if (id === undefined) return <ContactForm contact={null} />;
  if (contact.isPending) {
    return (
      <Page>
        <div aria-busy="true">
          <Skeleton width="40%" />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (contact.isError) {
    return (
      <Page>
        <ErrorNotice error={contact.error} onRetry={() => void contact.refetch()} />
        <LinkButton href="/contacts">{t('backToList')}</LinkButton>
      </Page>
    );
  }
  return <ContactForm contact={contact.data} />;
}

/**
 * C-3 contact form with the duplicate check. Display name is required (not
 * every culture fits given and family names). Date of birth, tax and
 * registration numbers are protected: typed here, encrypted by the API, never
 * echoed back (ADR-007); on edit the form says only whether one is recorded.
 */
function ContactForm({ contact }: { contact: ContactDto | null }) {
  const t = useTranslations('contacts');
  const crm = useTranslations('crm');
  const common = useTranslations('common');
  const router = useRouter();
  const search = useSearchParams();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { session, grant } = useSession();
  const { offices } = useOffices('contact.view');
  const sources = usePicklist('lead_source');
  const locales = useLocales();
  const countries = useCountries();
  const duplicates = useDuplicateCheck();
  const editing = contact !== null;
  const [form, setForm] = useState<FormState>(() => initial(contact));
  const presetRole = search.get('role');
  const [roles, setRoles] = useState<ContactRole[]>(CONTACT_ROLES.includes(presetRole as ContactRole) ? [presetRole as ContactRole] : []);
  const [owner, setOwner] = useState<PickedMember | null>(contact?.owner ? { membershipId: contact.owner.id, displayName: contact.owner.name } : null);
  const [consents, setConsents] = useState<{ alerts: ConsentChannel | null; marketing: ConsentChannel | null }>({ alerts: null, marketing: null });
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const ids = {
    displayName: useId(),
    primaryPhone: useId(),
    primaryEmail: useId(),
    sourceCode: useId(),
    dateOfBirth: useId(),
    taxNumber: useId(),
    organisationRegNumber: useId(),
    officeId: useId(),
  };
  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setDirty(true);
  };
  const ownerEditable = grant('contact.update')?.scope !== 'own';
  const person = form.contactType === 'person';

  const submit = async () => {
    const errors: Record<string, string> = {};
    if (form.displayName.trim() === '') errors['displayName'] = t('displayNameRequired');
    if (!editing && form.primaryPhone.trim() === '' && form.primaryEmail.trim() === '') errors['primaryPhone'] = t('phoneOrEmailRequired');
    if (form.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(form.dateOfBirth)) errors['dateOfBirth'] = t('dateInvalid');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    const fields: UpdateContactBody = {
      displayName: form.displayName.trim(),
      displayNameLocal: orNull(form.displayNameLocal),
      title: person ? orNull(form.title) : null,
      givenName: person ? orNull(form.givenName) : null,
      familyName: person ? orNull(form.familyName) : null,
      otherNames: person ? orNull(form.otherNames) : null,
      organisationName: person ? null : orNull(form.organisationName),
      primaryPhone: orNull(form.primaryPhone),
      primaryEmail: orNull(form.primaryEmail),
      preferredChannel: orNull(form.preferredChannel) as UpdateContactBody['preferredChannel'],
      preferredLocaleCode: orNull(form.preferredLocaleCode),
      sourceCode: orNull(form.sourceCode),
      officeId: orNull(form.officeId),
      nationalityCountryCode: orNull(form.nationalityCountryCode),
      residenceCountryCode: orNull(form.residenceCountryCode),
      notes: orNull(form.notes),
      ...(ownerEditable && owner ? { ownerMembershipId: owner.membershipId } : {}),
      // Protected values are sent only when typed: an empty field leaves what is recorded.
      ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
      ...(form.taxNumber.trim() ? { taxNumber: form.taxNumber.trim() } : {}),
      ...(!person && form.organisationRegNumber.trim() ? { organisationRegNumber: form.organisationRegNumber.trim() } : {}),
      ...(duplicates.confirmed ? { confirmNotDuplicate: true } : {}),
    };
    try {
      if (editing) {
        await bffRequest<ContactDto>(`contacts/${contact.id}`, { method: 'PATCH', version: contact.version, body: fields });
        announce(t('saved', { name: form.displayName.trim() }));
        await refresh();
        setDirty(false);
        router.push(`/contacts/${contact.id}`);
      } else {
        const consentRows: ConsentInput[] = [];
        if (consents.alerts) consentRows.push({ purpose: 'property_alerts', channel: consents.alerts, status: 'granted', lawfulBasis: 'consent', capturedVia: 'web_form' });
        if (consents.marketing) consentRows.push({ purpose: 'marketing', channel: consents.marketing, status: 'granted', lawfulBasis: 'consent', capturedVia: 'web_form' });
        const body: CreateContactBody = { ...fields, contactType: form.contactType, relationships: roles, consents: consentRows };
        const created = await bffRequest<ContactDto>('contacts', { method: 'POST', body, idempotencyKey: key });
        announce(t('created', { name: created.data.displayName }));
        await refresh();
        setDirty(false);
        router.push(`/contacts/${created.data.id}`);
      }
    } catch (caught) {
      if (!duplicates.fromError(caught)) setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (field: string) => clientErrors[field] ?? fieldErrorsOf(error)[field];
  const protectedNote = (field: 'dateOfBirth' | 'taxNumber' | 'organisationRegNumber') => {
    const value = contact?.protected?.[field];
    if (!editing || value === undefined) return t('protectedNew');
    return value.recorded ? t('protectedRecorded') : t('protectedNotRecorded');
  };
  const optionList = (items: Array<{ id: string; label: string }>) => [{ id: NONE, label: common('notSet') }, ...items];
  const title = editing ? t('editTitle', { name: contact.displayName }) : t('newTitle');

  return (
    <Page>
      <UnsavedChangesGuard dirty={dirty && !busy} />
      <PageHeader title={title} back={editing ? { href: `/contacts/${contact.id}`, label: contact.displayName } : { href: '/contacts', label: t('backToList') }} />
      <form
        className={formClass}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error instanceof ApiError && error.status === 412 ? (
          <Notice tone="warning" title={common('conflictTitle')}>
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem
            error={error}
            clientErrors={clientErrors}
            fields={{
              displayName: { label: t('displayName'), id: ids.displayName },
              primaryPhone: { label: t('mobile'), id: ids.primaryPhone },
              primaryEmail: { label: t('email'), id: ids.primaryEmail },
              sourceCode: { label: t('source'), id: ids.sourceCode },
              dateOfBirth: { label: t('dateOfBirth'), id: ids.dateOfBirth },
              taxNumber: { label: t('taxNumber'), id: ids.taxNumber },
              organisationRegNumber: { label: t('regNumber'), id: ids.organisationRegNumber },
              officeId: { label: t('office'), id: ids.officeId },
            }}
          />
        )}
        <Panel title={t('identitySection')}>
          {!editing ? (
            <RadioGroupField
              label={t('contactType')}
              value={form.contactType}
              onChange={(value) => set('contactType', value as FormState['contactType'])}
              options={[
                { id: 'person', label: crm('contactType.person') },
                { id: 'organisation', label: crm('contactType.organisation') },
              ]}
            />
          ) : null}
          <TextField id={ids.displayName} label={t('displayName')} description={t('displayNameHelp')} value={form.displayName} onChange={(value) => set('displayName', value)} isRequired maxLength={200} dir="auto" error={fieldError('displayName')} />
          <TextField label={t('displayNameLocal')} description={t('displayNameLocalHelp')} value={form.displayNameLocal} onChange={(value) => set('displayNameLocal', value)} maxLength={200} dir="auto" />
          {person ? (
            <FieldRow>
              <TextField label={t('titleField')} value={form.title} onChange={(value) => set('title', value)} maxLength={30} dir="auto" />
              <TextField label={t('givenName')} value={form.givenName} onChange={(value) => set('givenName', value)} maxLength={100} dir="auto" />
              <TextField label={t('familyName')} value={form.familyName} onChange={(value) => set('familyName', value)} maxLength={100} dir="auto" />
              <TextField label={t('otherNames')} value={form.otherNames} onChange={(value) => set('otherNames', value)} maxLength={100} dir="auto" />
            </FieldRow>
          ) : (
            <TextField label={t('organisationName')} value={form.organisationName} onChange={(value) => set('organisationName', value)} maxLength={200} dir="auto" />
          )}
        </Panel>
        <Panel title={t('reachSection')}>
          {/* The check runs as focus leaves the phone and email fields (focusout bubbles). */}
          <div onBlur={() => void duplicates.check({ primaryPhone: form.primaryPhone, primaryEmail: form.primaryEmail, officeId: orNull(form.officeId), ...(editing ? { excludeContactId: contact.id } : {}) })}>
            <FieldRow>
              <TextField
                id={ids.primaryPhone}
                label={t('mobile')}
                description={t('phoneHelp')}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={form.primaryPhone}
                onChange={(value) => set('primaryPhone', value)}
                dir="ltr"
                maxLength={40}
                error={fieldError('primaryPhone')}
              />
              <TextField id={ids.primaryEmail} label={t('email')} type="email" inputMode="email" autoComplete="off" value={form.primaryEmail} onChange={(value) => set('primaryEmail', value)} dir="ltr" maxLength={320} error={fieldError('primaryEmail')} />
            </FieldRow>
          </div>
          <DuplicatePanel candidates={duplicates.candidates} confirmed={duplicates.confirmed} onConfirm={duplicates.confirm} />
          <FieldRow>
            <SelectField label={t('preferredChannel')} value={form.preferredChannel} onChange={(value) => set('preferredChannel', value)} options={optionList(CHANNELS.map((id) => ({ id, label: t(`channel.${id}`) })))} />
            <SelectField
              label={t('language')}
              value={form.preferredLocaleCode}
              onChange={(value) => set('preferredLocaleCode', value)}
              options={optionList((locales.data?.data ?? []).map((locale) => ({ id: locale.code, label: locale.name })))}
            />
          </FieldRow>
        </Panel>
        {!editing ? (
          <Panel title={t('rolesSection')}>
            <Fieldset legend={t('roles')}>
              {CONTACT_ROLES.map((role) => (
                <Checkbox
                  key={role}
                  isSelected={roles.includes(role)}
                  onChange={(selected) => {
                    setRoles(selected ? [...roles, role] : roles.filter((item) => item !== role));
                    setDirty(true);
                  }}
                >
                  {crm(`role.${role}`)}
                </Checkbox>
              ))}
            </Fieldset>
          </Panel>
        ) : null}
        <Panel title={t('workSection')}>
          <FieldRow>
            <SelectField
              id={ids.sourceCode}
              label={t('source')}
              value={form.sourceCode}
              onChange={(value) => set('sourceCode', value)}
              options={optionList((sources.data?.data ?? []).map((value) => ({ id: value.code, label: value.label })))}
              error={fieldError('sourceCode')}
            />
            <SelectField id={ids.officeId} label={t('office')} value={form.officeId} onChange={(value) => set('officeId', value)} options={optionList(offices.map((office) => ({ id: office.id, label: office.name })))} error={fieldError('officeId')} />
          </FieldRow>
          {ownerEditable ? (
            <PeoplePicker label={t('owner')} description={t('ownerHelp')} value={owner} onChange={setOwner} permission="contact.view" {...(orNull(form.officeId) ? { officeId: form.officeId } : {})} error={fieldError('ownerMembershipId')} />
          ) : (
            <p>{t('ownerFixed', { name: contact?.owner?.name ?? session.user.displayName })}</p>
          )}
        </Panel>
        {!editing ? (
          <Panel title={t('consentSection')}>
            <p>{t('consentHelp')}</p>
            <FieldRow>
              <SelectField
                label={t('consentAlerts')}
                value={consents.alerts ?? NONE}
                onChange={(value) => setConsents({ ...consents, alerts: value === NONE ? null : (value as ConsentChannel) })}
                options={[{ id: NONE, label: t('consentNone') }, ...CONSENT_CHANNELS.map((id) => ({ id, label: crm(`consentChannel.${id}`) }))]}
              />
              <SelectField
                label={t('consentMarketing')}
                value={consents.marketing ?? NONE}
                onChange={(value) => setConsents({ ...consents, marketing: value === NONE ? null : (value as ConsentChannel) })}
                options={[{ id: NONE, label: t('consentNone') }, ...CONSENT_CHANNELS.map((id) => ({ id, label: crm(`consentChannel.${id}`) }))]}
              />
            </FieldRow>
          </Panel>
        ) : null}
        <Panel title={t('moreSection')}>
          <FieldRow>
            <SelectField
              label={t('nationality')}
              value={form.nationalityCountryCode}
              onChange={(value) => set('nationalityCountryCode', value)}
              options={optionList((countries.data?.data ?? []).map((country) => ({ id: country.code, label: country.name })))}
            />
            <SelectField
              label={t('residence')}
              value={form.residenceCountryCode}
              onChange={(value) => set('residenceCountryCode', value)}
              options={optionList((countries.data?.data ?? []).map((country) => ({ id: country.code, label: country.name })))}
            />
          </FieldRow>
          <TextField label={common('notes')} description={t('notesHelp')} value={form.notes} onChange={(value) => set('notes', value)} multiline maxLength={5000} dir="auto" />
        </Panel>
        <Panel title={t('protectedSection')}>
          <Notice tone="info">{t('protectedHelp')}</Notice>
          {person ? (
            <TextField
              id={ids.dateOfBirth}
              label={t('dateOfBirth')}
              description={protectedNote('dateOfBirth')}
              type="date"
              autoComplete="off"
              value={form.dateOfBirth}
              onChange={(value) => set('dateOfBirth', value)}
              error={fieldError('dateOfBirth')}
            />
          ) : null}
          <TextField id={ids.taxNumber} label={t('taxNumber')} description={protectedNote('taxNumber')} autoComplete="off" value={form.taxNumber} onChange={(value) => set('taxNumber', value)} dir="ltr" maxLength={60} error={fieldError('taxNumber')} />
          {!person ? (
            <TextField
              id={ids.organisationRegNumber}
              label={t('regNumber')}
              description={protectedNote('organisationRegNumber')}
              autoComplete="off"
              value={form.organisationRegNumber}
              onChange={(value) => set('organisationRegNumber', value)}
              dir="ltr"
              maxLength={60}
              error={fieldError('organisationRegNumber')}
            />
          ) : null}
        </Panel>
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            {editing ? common('save') : t('create')}
          </Button>{' '}
          <LinkButton href={editing ? `/contacts/${contact.id}` : '/contacts'}>{common('cancel')}</LinkButton>
        </div>
      </form>
    </Page>
  );
}
