'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useContact } from '@/components/crm/use-crm';
import { ContactSearch } from '@/components/leads/new-lead';
import { Button, LinkButton } from '@/components/ui/button';
import { FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass, Page, PageHeader, Panel } from '@/components/ui/layout';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-guard';
import type { ContactSummaryDto, CreatePrivacyRequestBody, PrivacyRequestDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useRefreshAll } from '@/lib/mutations';

const CHANNELS = ['email', 'phone', 'in_person', 'post', 'web_form', 'other'] as const;

/** Logs a data-subject request (gap G3), for a contact chosen here or the one it was opened from. */
export function NewPrivacyRequest() {
  const t = useTranslations('privacy');
  const common = useTranslations('common');
  const router = useRouter();
  const search = useSearchParams();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const presetId = search.get('contactId');
  const preset = useContact(presetId ?? '', presetId !== null);
  const [contact, setContact] = useState<ContactSummaryDto | null>(null);
  const [requestType, setRequestType] = useState<CreatePrivacyRequestBody['requestType']>(search.get('type') === 'erasure' ? 'erasure' : 'access');
  const [channel, setChannel] = useState<CreatePrivacyRequestBody['channel']>('email');
  const [receivedOn, setReceivedOn] = useState(new Date().toISOString().slice(0, 10));
  const [assignee, setAssignee] = useState<PickedMember | null>(null);
  const [summary, setSummary] = useState('');
  const [dirty, setDirty] = useState(false);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ids = { contact: useId(), received: useId(), summary: useId() };
  const contactId = presetId ?? contact?.id ?? null;

  const submit = async () => {
    const errors: Record<string, string> = {};
    if (contactId === null) errors['contactId'] = t('personRequired');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreatePrivacyRequestBody = {
        contactId: contactId!,
        requestType,
        channel,
        receivedOn,
        ...(assignee ? { assignedTo: assignee.membershipId } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
      };
      const created = await bff<PrivacyRequestDto>('privacy-requests', { method: 'POST', body });
      announce(t('created', { reference: created.reference }));
      setDirty(false);
      await refresh();
      router.push(`/privacy-requests/${created.id}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const fieldError = (field: string) => clientErrors[field] ?? fieldErrorsOf(error)[field];

  return (
    <Page>
      <UnsavedChangesGuard dirty={dirty && !busy} />
      <PageHeader title={t('newTitle')} subtitle={t('newSubtitle')} back={{ href: '/privacy-requests', label: t('backToList') }} />
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
            contactId: { label: t('person'), id: ids.contact },
            receivedOn: { label: t('receivedOn'), id: ids.received },
            summary: { label: t('summary'), id: ids.summary },
          }}
        />
        <Panel title={t('person')}>
          {presetId ? (
            <p>
              <bdi dir="auto">{preset.data?.displayName ?? ''}</bdi>
            </p>
          ) : (
            <ContactSearch value={contact} onChange={setContact} labelId={ids.contact} label={t('person')} help={t('personHelp')} error={fieldError('contactId')} />
          )}
        </Panel>
        <Panel title={t('details')}>
          <RadioGroupField
            label={t('requestType')}
            value={requestType}
            onChange={(value) => setRequestType(value as CreatePrivacyRequestBody['requestType'])}
            isRequired
            options={(['access', 'erasure'] as const).map((id) => ({ id, label: t(`typeLong.${id}`) }))}
          />
          <FieldRow>
            <SelectField label={t('channelLabel')} value={channel} onChange={(value) => setChannel(value as CreatePrivacyRequestBody['channel'])} isRequired options={CHANNELS.map((id) => ({ id, label: t(`channel.${id}`) }))} />
            <TextField
              id={ids.received}
              label={t('receivedOn')}
              description={t('receivedOnHelp')}
              type="date"
              value={receivedOn}
              onChange={setReceivedOn}
              isRequired
              max={new Date().toISOString().slice(0, 10)}
              error={fieldError('receivedOn')}
            />
          </FieldRow>
          <PeoplePicker label={t('assignTo')} value={assignee} onChange={setAssignee} permission="privacy.manage" error={fieldError('assignedTo')} />
          <TextField id={ids.summary} label={t('summary')} description={t('summaryHelp')} value={summary} onChange={setSummary} multiline maxLength={1000} dir="auto" error={fieldError('summary')} />
        </Panel>
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            {t('create')}
          </Button>{' '}
          <LinkButton href="/privacy-requests">{common('cancel')}</LinkButton>
        </div>
      </form>
    </Page>
  );
}
