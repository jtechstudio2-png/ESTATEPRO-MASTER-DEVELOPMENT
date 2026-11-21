'use client';

import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { ContactSearch } from '@/components/leads/new-lead';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Checkbox, FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import type { ContactSummaryDto, DealDto, DealMilestoneDto, LeadDto, ListingListItemDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useCurrencies, usePicklist } from '@/lib/hooks/reference';
import { todayIn } from '@/lib/time';

import { ListingSearch } from './record-search';
import { MoneyText } from './sales-labels';
import styles from './sales.module.css';
import { splitsComplete, splitsTotal } from './sales-rules';
import { useAction } from './use-sales';

const AMOUNT = /^\d{1,13}(\.\d{1,4})?$/;
const PARTY_ROLES = ['buyer', 'seller', 'tenant', 'landlord', 'guarantor', 'buyer_lawyer', 'seller_lawyer', 'lender', 'other_agent', 'other'] as const;
const AGENT_ROLES = ['lister', 'seller_agent', 'co_agent', 'referrer'] as const;

/** An amount and its currency; the currency is fixed when the deal already has one (S3-D14, no conversion). */
function MoneyField({ label, amount, currency, onAmount, onCurrency, error, id, fixedCurrency, description }: { label: string; amount: string; currency: string; onAmount: (value: string) => void; onCurrency: (value: string) => void; error?: string | undefined; id: string; fixedCurrency?: boolean; description?: string }) {
  const t = useTranslations('sales');
  const currencies = useCurrencies();
  return (
    <FieldRow>
      {fixedCurrency ? (
        <TextField label={t('currency')} value={currency} onChange={() => undefined} isDisabled dir="ltr" />
      ) : (
        <SelectField label={t('currency')} value={currency} onChange={onCurrency} options={(currencies.data?.data ?? []).map((item) => ({ id: item.code, label: item.code }))} />
      )}
      <TextField id={id} label={label} value={amount} onChange={onAmount} inputMode="decimal" dir="ltr" error={error} {...(description ? { description } : {})} />
    </FieldRow>
  );
}

/** Whether the member manages deals (office or all scope): managers choose owners and edit splits (S3-D6). */
function useManagesDeals(): boolean {
  const { grant } = useSession();
  const scope = grant('deal.update')?.scope;
  return scope === 'office' || scope === 'all';
}

/** DL-2 new deal (direct), from the deals list, board or a contact record. Opens the new deal (DL-3). */
export function NewDealDialog({ presetContact, onClose }: { presetContact: { id: string } | null; onClose: () => void }) {
  const t = useTranslations('sales');
  const router = useRouter();
  const { session } = useSession();
  const manages = useManagesDeals();
  const sources = usePicklist('lead_source');
  const action = useAction();
  const [dealType, setDealType] = useState<'sale' | 'letting'>('sale');
  const [contact, setContact] = useState<ContactSummaryDto | null>(null);
  const [listing, setListing] = useState<ListingListItemDto | null>(null);
  const [source, setSource] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(session.company.baseCurrencyCode);
  const [close, setClose] = useState('');
  const [owner, setOwner] = useState<PickedMember | null>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const ids = { contact: useId(), listing: useId(), amount: useId(), close: useId(), type: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const fieldError = (key: string) => clientErrors[key] ?? serverErrors[key];

  const submit = () => {
    const errors: Record<string, string> = {};
    if (!presetContact && contact === null) errors['primaryContactId'] = t('contactRequired');
    if (amount !== '' && !AMOUNT.test(amount)) errors['expectedValue'] = t('amountInvalid');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void action.run(
      () =>
        bff<DealDto>('deals', {
          method: 'POST',
          body: {
            dealType,
            primaryContactId: presetContact?.id ?? contact!.id,
            ...(listing ? { listingId: listing.id } : {}),
            ...(source ? { sourceCode: source } : {}),
            ...(amount ? { expectedValue: { amount, currency: listing ? listing.price.currency : currency } } : {}),
            ...(close ? { expectedCloseDate: close } : {}),
            ...(owner ? { ownerMembershipId: owner.membershipId } : {}),
          },
        }),
      t('dealCreated'),
      (deal) => {
        onClose();
        router.push(`/deals/${deal.id}`);
      },
    );
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('newDeal')} consequence={t('newDealConsequence')} confirmLabel={t('create')} onConfirm={submit} busy={action.busy}>
      <FormProblem
        error={action.error}
        clientErrors={clientErrors}
        fields={{ primaryContactId: { label: t('buyerOrTenant'), id: ids.contact }, listingId: { label: t('listing'), id: ids.listing }, expectedValue: { label: t('expectedValue'), id: ids.amount }, expectedCloseDate: { label: t('expectedClose'), id: ids.close } }}
      />
      <RadioGroupField
        label={t('dealType')}
        value={dealType}
        onChange={(value) => {
          setDealType(value as 'sale' | 'letting');
          setListing(null);
        }}
        options={(['sale', 'letting'] as const).map((id) => ({ id, label: t(`dealTypeName.${id}`) }))}
        isRequired
      />
      {presetContact ? null : <ContactSearch value={contact} onChange={setContact} labelId={ids.contact} label={dealType === 'sale' ? t('buyer') : t('tenant')} help={t('contactHelp')} error={fieldError('primaryContactId')} />}
      <ListingSearch
        key={dealType}
        label={t('listing')}
        help={t('listingHelp')}
        listingType={dealType === 'sale' ? 'sale' : 'rent'}
        value={listing ? { id: listing.id, label: `${listing.reference} ${listing.title}` } : null}
        onChange={(item) => {
          setListing(item);
          if (item && amount === '') setAmount(item.price.amount);
        }}
        labelId={ids.listing}
        error={fieldError('listingId')}
      />
      {sources.data && sources.data.data.length > 0 ? (
        <SelectField label={t('source')} value={source} onChange={setSource} placeholder={t('noSource')} options={[{ id: '', label: t('noSource') }, ...sources.data.data.map((value) => ({ id: value.code, label: value.label }))]} />
      ) : null}
      <MoneyField id={ids.amount} label={t('expectedValue')} amount={amount} currency={listing ? listing.price.currency : currency} onAmount={setAmount} onCurrency={setCurrency} fixedCurrency={listing !== null} error={fieldError('expectedValue') ?? fieldError('expectedValue.amount')} />
      <TextField id={ids.close} label={t('expectedClose')} type="date" value={close} onChange={setClose} error={fieldError('expectedCloseDate')} />
      {manages ? <PeoplePicker label={t('owner')} value={owner} onChange={setOwner} permission="deal.view" description={t('ownerHelp')} error={fieldError('ownerMembershipId')} /> : null}
    </ConfirmDialog>
  );
}

/** CV-1 convert a buy or rent lead to a deal (once); opens the new deal. */
export function ConvertLeadDialog({ lead, onClose }: { lead: LeadDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const router = useRouter();
  const action = useAction();
  const [listing, setListing] = useState<{ id: string; label: string } | null>(lead.listing ? { id: lead.listing.id, label: `${lead.listing.reference} ${lead.listing.title}` } : null);
  const ids = { listing: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const submit = () =>
    void action.run(
      () => bff<DealDto>(`leads/${lead.id}/convert`, { method: 'POST', version: lead.version, body: listing ? { listingId: listing.id } : {} }),
      t('leadConverted', { reference: lead.reference }),
      (deal) => {
        onClose();
        router.push(`/deals/${deal.id}`);
      },
    );
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('convertTitle', { reference: lead.reference })} consequence={t('convertConsequence')} confirmLabel={t('convert')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} fields={{ listingId: { label: t('listing'), id: ids.listing } }} />
      <dl className={styles.list}>
        <div>
          <dt>{lead.leadType === 'rent' ? t('tenant') : t('buyer')}</dt>
          <dd>
            <bdi dir="auto">{lead.contact.name}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('owner')}</dt>
          <dd>{lead.assignedTo ? <bdi>{lead.assignedTo.name}</bdi> : t('ownerYou')}</dd>
        </div>
      </dl>
      <ListingSearch
        label={t('listing')}
        help={t('convertListingHelp')}
        listingType={lead.leadType === 'rent' ? 'rent' : 'sale'}
        value={listing}
        onChange={(item) => setListing(item ? { id: item.id, label: `${item.reference} ${item.title}` } : null)}
        labelId={ids.listing}
        error={serverErrors['listingId']}
      />
    </ConfirmDialog>
  );
}

/** Edit value, close date and probability (`access.canEdit`, PATCH with If-Match). */
export function EditDealDialog({ deal, onClose }: { deal: DealDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const currency = deal.expectedValue?.currency ?? deal.acceptedOffer?.amount.currency ?? deal.expectedFee?.currency;
  const { session } = useSession();
  const [chosenCurrency, setChosenCurrency] = useState(currency ?? session.company.baseCurrencyCode);
  const [amount, setAmount] = useState(deal.expectedValue?.amount ?? '');
  const [fee, setFee] = useState(deal.expectedFee?.amount ?? '');
  const [close, setClose] = useState(deal.expectedCloseDate ?? '');
  const [probability, setProbability] = useState(deal.probabilityOverride === null ? '' : String(deal.probabilityOverride));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const ids = { amount: useId(), fee: useId(), close: useId(), probability: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const fieldError = (key: string) => clientErrors[key] ?? serverErrors[key] ?? serverErrors[`${key}.amount`];
  const submit = () => {
    const errors: Record<string, string> = {};
    if (amount !== '' && !AMOUNT.test(amount)) errors['expectedValue'] = t('amountInvalid');
    if (fee !== '' && !AMOUNT.test(fee)) errors['expectedFee'] = t('amountInvalid');
    if (probability !== '' && !(/^\d{1,3}$/.test(probability) && Number(probability) <= 100)) errors['probabilityOverride'] = t('probabilityInvalid');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const money = (value: string) => (value === '' ? null : { amount: value, currency: chosenCurrency });
    void action.run(
      () =>
        bff(`deals/${deal.id}`, {
          method: 'PATCH',
          version: deal.version,
          body: { expectedValue: money(amount), expectedFee: money(fee), expectedCloseDate: close === '' ? null : close, probabilityOverride: probability === '' ? null : Number(probability) },
        }),
      t('dealSaved'),
      onClose,
    );
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('editDealTitle', { reference: deal.reference })} consequence={t('editDealConsequence')} confirmLabel={t('save')} onConfirm={submit} busy={action.busy}>
      <FormProblem
        error={action.error}
        clientErrors={clientErrors}
        fields={{ expectedValue: { label: t('expectedValue'), id: ids.amount }, expectedFee: { label: t('expectedFee'), id: ids.fee }, expectedCloseDate: { label: t('expectedClose'), id: ids.close }, probabilityOverride: { label: t('probability'), id: ids.probability } }}
      />
      <MoneyField id={ids.amount} label={t('expectedValue')} amount={amount} currency={chosenCurrency} onAmount={setAmount} onCurrency={setChosenCurrency} fixedCurrency={currency !== undefined} error={fieldError('expectedValue')} />
      <TextField id={ids.fee} label={t('expectedFee')} value={fee} onChange={setFee} inputMode="decimal" dir="ltr" error={fieldError('expectedFee')} description={t('feeHelp', { currency: chosenCurrency })} />
      <TextField id={ids.close} label={t('expectedClose')} type="date" value={close} onChange={setClose} error={fieldError('expectedCloseDate')} />
      <TextField id={ids.probability} label={t('probability')} value={probability} onChange={setProbability} inputMode="numeric" dir="ltr" description={t('probabilityHelp', { stage: deal.probability })} error={fieldError('probabilityOverride')} />
    </ConfirmDialog>
  );
}

/** DL-4 move stage: only the stages the API allows (`access.nextStages`, W-D1). */
export function MoveStageDialog({ deal, onClose }: { deal: DealDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const [stageId, setStageId] = useState(deal.access.nextStages[0]?.id ?? '');
  const [note, setNote] = useState('');
  const target = deal.access.nextStages.find((stage) => stage.id === stageId);
  const submit = () =>
    void action.run(() => bff(`deals/${deal.id}/stage`, { method: 'POST', version: deal.version, body: { stageId, ...(note.trim() ? { note: note.trim() } : {}) } }), t('movedTo', { reference: deal.reference, stage: target?.name ?? '' }), onClose);
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('moveTitle', { reference: deal.reference })} consequence={t('moveConsequence')} confirmLabel={t('move')} onConfirm={submit} busy={action.busy} canConfirm={stageId !== ''}>
      <FormProblem error={action.error} fields={{}} />
      <SelectField label={t('moveTo')} value={stageId} onChange={setStageId} options={deal.access.nextStages.map((stage) => ({ id: stage.id, label: stage.name }))} isRequired />
      <TextField label={t('note')} value={note} onChange={setNote} multiline maxLength={2000} dir="auto" description={t('noIdNumbers')} />
    </ConfirmDialog>
  );
}

/** DL-4 reassign (managers): the owner history keeps the note (S3-D7). */
export function ReassignDialog({ deal, onClose }: { deal: DealDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const [owner, setOwner] = useState<PickedMember | null>(null);
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const serverErrors = fieldErrorsOf(action.error);
  const submit = () => {
    if (owner === null) {
      setMissing(true);
      return;
    }
    void action.run(
      () => bff(`deals/${deal.id}/reassign`, { method: 'POST', version: deal.version, body: { ownerMembershipId: owner.membershipId, ...(note.trim() ? { note: note.trim() } : {}) } }),
      t('reassigned', { reference: deal.reference, name: owner.displayName }),
      onClose,
    );
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('reassignTitle', { reference: deal.reference })} consequence={t('reassignConsequence', { name: deal.owner.name })} confirmLabel={t('reassign')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} fields={{}} />
      <PeoplePicker
        label={t('newOwner')}
        value={owner}
        onChange={(member) => {
          setOwner(member);
          setMissing(false);
        }}
        permission="deal.view"
        officeId={deal.office.id}
        isRequired
        error={missing ? t('ownerRequired') : serverErrors['ownerMembershipId']}
      />
      <TextField label={t('note')} value={note} onChange={setNote} multiline maxLength={2000} dir="auto" description={t('noIdNumbers')} />
    </ConfirmDialog>
  );
}

interface AgentRow {
  key: string;
  member: PickedMember | null;
  agentRole: (typeof AGENT_ROLES)[number];
  splitPercent: string;
}

/** DL-4 agents and splits (managers): the total is shown live and must be 100 % (S3-D6). */
export function AgentsDialog({ deal, onClose }: { deal: DealDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const format = useFormat();
  const action = useAction();
  const [rows, setRows] = useState<AgentRow[]>(() =>
    deal.agents.map((agent, index) => ({ key: `a${index}`, member: { membershipId: agent.member.id, displayName: agent.member.name }, agentRole: agent.agentRole, splitPercent: String(agent.splitPercent) })),
  );
  const [clientError, setClientError] = useState<string | null>(null);
  const splits = rows.map((row) => row.splitPercent || '0');
  const total = splitsTotal(splits) / 10_000;
  const complete = splitsComplete(splits);
  const update = (key: string, change: Partial<AgentRow>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const submit = () => {
    if (rows.some((row) => row.member === null)) {
      setClientError(t('agentRequired'));
      return;
    }
    if (rows.some((row) => !/^\d{1,3}(\.\d{1,4})?$/.test(row.splitPercent)) || !complete) {
      setClientError(t('splitsMustTotal'));
      return;
    }
    setClientError(null);
    void action.run(
      () => bff(`deals/${deal.id}/agents`, { method: 'PUT', version: deal.version, body: { agents: rows.map((row) => ({ membershipId: row.member!.membershipId, agentRole: row.agentRole, splitPercent: Number(row.splitPercent) })) } }),
      t('agentsSaved'),
      onClose,
    );
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('agentsTitle', { reference: deal.reference })} consequence={t('agentsConsequence')} confirmLabel={t('save')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} clientErrors={clientError ? { agents: clientError } : {}} fields={{}} />
      {rows.map((row, index) => (
        <fieldset key={row.key} className={styles.splitRow}>
          <legend className="ep-visually-hidden">{t('agentNumber', { number: index + 1 })}</legend>
          <PeoplePicker label={t('agent')} value={row.member} onChange={(member) => update(row.key, { member })} permission="deal.view" officeId={deal.office.id} isRequired />
          <SelectField label={t('agentRole')} value={row.agentRole} onChange={(value) => update(row.key, { agentRole: value as AgentRow['agentRole'] })} options={AGENT_ROLES.map((id) => ({ id, label: t(`agentRoleName.${id}`) }))} />
          <TextField label={t('splitPercent')} value={row.splitPercent} onChange={(value) => update(row.key, { splitPercent: value })} inputMode="decimal" dir="ltr" />
          <Button variant="quiet" onPress={() => setRows((current) => current.filter((item) => item.key !== row.key))} aria-label={t('removeAgent', { number: index + 1 })}>
            {t('remove')}
          </Button>
        </fieldset>
      ))}
      <p role="status" className={styles.actions}>
        <span aria-hidden="true">{complete ? '✓' : '⚠'}</span>
        <span>{t('splitsTotal', { total: format.number(total, { maximumFractionDigits: 4 }) })}</span>
        {complete ? null : <span>{t('splitsMustTotal')}</span>}
      </p>
      <Button onPress={() => setRows((current) => [...current, { key: `n${Date.now()}`, member: null, agentRole: 'co_agent', splitPercent: '0' }])}>{t('addAgent')}</Button>
    </ConfirmDialog>
  );
}

/** DL-4 add a party (contact and role); the primary contact cannot be removed (S3-D5). */
export function AddPartyDialog({ deal, onClose }: { deal: DealDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const [contact, setContact] = useState<ContactSummaryDto | null>(null);
  const [role, setRole] = useState<(typeof PARTY_ROLES)[number]>(deal.dealType === 'sale' ? 'buyer' : 'tenant');
  const [missing, setMissing] = useState(false);
  const ids = { contact: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const submit = () => {
    if (contact === null) {
      setMissing(true);
      return;
    }
    void action.run(() => bff(`deals/${deal.id}/parties`, { method: 'POST', version: deal.version, body: { contactId: contact.id, partyRole: role } }), t('partyAdded', { name: contact.displayName }), onClose);
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('addPartyTitle', { reference: deal.reference })} consequence={t('addPartyConsequence')} confirmLabel={t('add')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} clientErrors={missing ? { contactId: t('contactRequired') } : {}} fields={{ contactId: { label: t('contact'), id: ids.contact } }} />
      <ContactSearch value={contact} onChange={setContact} labelId={ids.contact} label={t('contact')} help={t('contactHelp')} error={missing ? t('contactRequired') : serverErrors['contactId']} />
      <SelectField label={t('partyRole')} value={role} onChange={(value) => setRole(value as (typeof PARTY_ROLES)[number])} options={PARTY_ROLES.map((id) => ({ id, label: t(`partyRoleName.${id}`) }))} isRequired />
    </ConfirmDialog>
  );
}

export function RemovePartyDialog({ deal, party, onClose }: { deal: DealDto; party: DealDto['parties'][number]; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const submit = () =>
    void action.run(() => bff(`deals/${deal.id}/parties/remove`, { method: 'POST', version: deal.version, body: { contactId: party.contact.id, partyRole: party.partyRole } }), t('partyRemoved', { name: party.contact.name }), onClose);
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('removePartyTitle', { name: party.contact.name })}
      consequence={t('removePartyConsequence', { role: t(`partyRoleName.${party.partyRole}`) })}
      confirmLabel={t('remove')}
      onConfirm={submit}
      busy={action.busy}
      danger
    >
      <FormProblem error={action.error} fields={{}} />
    </ConfirmDialog>
  );
}

/** DL-5 mark a milestone done (final) with optional notes. */
export function CompleteMilestoneDialog({ deal, milestone, onClose }: { deal: DealDto; milestone: DealMilestoneDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const [notes, setNotes] = useState('');
  const submit = () =>
    void action.run(() => bff(`deals/${deal.id}/milestones/${milestone.id}/complete`, { method: 'POST', version: deal.version, body: notes.trim() ? { notes: notes.trim() } : {} }), t('milestoneDone', { name: milestone.name }), onClose);
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('milestoneDoneTitle', { name: milestone.name })} consequence={t('milestoneDoneConsequence')} confirmLabel={t('markDone')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} fields={{}} />
      <TextField label={t('notes')} value={notes} onChange={setNotes} multiline maxLength={2000} dir="auto" description={t('noIdNumbers')} />
    </ConfirmDialog>
  );
}

/** DL-5 edit a milestone's due date and notes. */
export function EditMilestoneDialog({ deal, milestone, onClose }: { deal: DealDto; milestone: DealMilestoneDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const action = useAction();
  const [due, setDue] = useState(milestone.dueDate ?? '');
  const [notes, setNotes] = useState(milestone.notes ?? '');
  const ids = { due: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const submit = () =>
    void action.run(() => bff(`deals/${deal.id}/milestones/${milestone.id}`, { method: 'PATCH', version: deal.version, body: { dueDate: due === '' ? null : due, notes: notes.trim() === '' ? null : notes.trim() } }), t('milestoneSaved', { name: milestone.name }), onClose);
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('milestoneEditTitle', { name: milestone.name })} consequence={t('milestoneEditConsequence')} confirmLabel={t('save')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} fields={{ dueDate: { label: t('dueDate'), id: ids.due } }} />
      <TextField id={ids.due} label={t('dueDate')} type="date" value={due} onChange={setDue} error={serverErrors['dueDate']} />
      <TextField label={t('notes')} value={notes} onChange={setNotes} multiline maxLength={2000} dir="auto" description={t('noIdNumbers')} />
    </ConfirmDialog>
  );
}

/** A line per unverified buyer, linked to their Identity tab (never document numbers, P6-D6). */
function UnverifiedBuyers({ deal }: { deal: DealDto }) {
  const t = useTranslations('sales');
  const unverified = deal.parties.filter((party) => deal.identity.unverifiedBuyerIds.includes(party.contact.id));
  if (unverified.length === 0) return null;
  return (
    <Notice tone="warning" title={t('buyersUnverified', { count: unverified.length })}>
      <ul>
        {unverified.map((party) => (
          <li key={party.contact.id}>
            <NextLink href={`/contacts/${party.contact.id}/identity`}>
              <bdi dir="auto">{party.contact.name}</bdi>
            </NextLink>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** DL-6 exchange contracts (sale deals at offer accepted, buyers verified when required). */
export function ExchangeDialog({ deal, onClose }: { deal: DealDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const { session } = useSession();
  const action = useAction();
  const [signed, setSigned] = useState(todayIn(session.timezone));
  const [due, setDue] = useState('');
  const [fee, setFee] = useState(deal.expectedFee?.amount ?? '');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const ids = { signed: useId(), due: useId(), fee: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const fieldError = (key: string) => clientErrors[key] ?? serverErrors[key] ?? serverErrors[`${key}.amount`];
  const currency = deal.acceptedOffer?.amount.currency ?? deal.expectedValue?.currency ?? session.company.baseCurrencyCode;
  const submit = () => {
    const errors: Record<string, string> = {};
    if (signed === '') errors['contractSignedOn'] = t('dateRequired');
    if (fee !== '' && !AMOUNT.test(fee)) errors['agencyFee'] = t('amountInvalid');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void action.run(
      () => bff(`deals/${deal.id}/exchange`, { method: 'POST', version: deal.version, body: { contractSignedOn: signed, ...(due ? { completionDueOn: due } : {}), ...(fee ? { agencyFee: { amount: fee, currency } } : {}) } }),
      t('exchanged', { reference: deal.reference }),
      onClose,
    );
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('exchangeTitle')} consequence={t('exchangeConsequence')} confirmLabel={t('exchange')} onConfirm={submit} busy={action.busy}>
      <FormProblem error={action.error} clientErrors={clientErrors} fields={{ contractSignedOn: { label: t('signedOn'), id: ids.signed }, completionDueOn: { label: t('completionDue'), id: ids.due }, agencyFee: { label: t('agencyFee'), id: ids.fee } }} />
      {deal.acceptedOffer ? (
        <p>
          {t('agreedPrice')}: <MoneyText money={deal.acceptedOffer.amount} />
        </p>
      ) : null}
      <UnverifiedBuyers deal={deal} />
      <TextField id={ids.signed} label={t('signedOn')} type="date" value={signed} onChange={setSigned} isRequired error={fieldError('contractSignedOn')} />
      <TextField id={ids.due} label={t('completionDue')} type="date" value={due} onChange={setDue} error={fieldError('completionDueOn')} />
      <TextField id={ids.fee} label={t('agencyFee')} value={fee} onChange={setFee} inputMode="decimal" dir="ltr" description={t('feeHelp', { currency })} error={fieldError('agencyFee')} />
    </ConfirmDialog>
  );
}

/** DL-7 complete the sale (`deal.close`), with the ownership transfer previewed and on by default. */
export function CompleteDialog({ deal, onClose }: { deal: DealDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const { session } = useSession();
  const action = useAction();
  const [completed, setCompleted] = useState(todayIn(session.timezone));
  const [titleRef, setTitleRef] = useState('');
  const [transfer, setTransfer] = useState(true);
  const ids = { completed: useId(), title: useId(), transfer: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const openRequired = deal.milestones.filter((milestone) => milestone.isRequired && milestone.completedAt === null);
  const buyers = deal.parties.filter((party) => party.partyRole === 'buyer');
  const submit = () =>
    void action.run(
      () => bff(`deals/${deal.id}/complete`, { method: 'POST', version: deal.version, body: { completedOn: completed, transferOwnership: transfer, ...(titleRef.trim() ? { titleTransferRef: titleRef.trim() } : {}) } }),
      t('completed', { reference: deal.reference }),
      onClose,
    );
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('completeTitle')} consequence={t('completeConsequence')} confirmLabel={t('complete')} onConfirm={submit} busy={action.busy} canConfirm={completed !== ''}>
      <FormProblem error={action.error} fields={{ completedOn: { label: t('completedOn'), id: ids.completed }, titleTransferRef: { label: t('titleRef'), id: ids.title } }} />
      {openRequired.length > 0 ? (
        <Notice tone="warning" title={t('requiredOpen', { count: openRequired.length })}>
          <ul>
            {openRequired.map((milestone) => (
              <li key={milestone.id}>{milestone.name}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        <p>
          <span aria-hidden="true">✓ </span>
          {t('requiredAllDone')}
        </p>
      )}
      <TextField id={ids.completed} label={t('completedOn')} type="date" value={completed} onChange={setCompleted} isRequired error={serverErrors['completedOn']} />
      <TextField id={ids.title} label={t('titleRef')} value={titleRef} onChange={setTitleRef} dir="ltr" maxLength={100} error={serverErrors['titleTransferRef']} />
      <Checkbox isSelected={transfer} onChange={setTransfer}>
        {t('transferOwnership')}
      </Checkbox>
      {transfer ? (
        <p className={styles.meta}>{buyers.length > 0 ? t('transferPreview', { names: buyers.map((party) => party.contact.name).join(', ') }) : t('transferNoBuyers')}</p>
      ) : null}
      {serverErrors['transferOwnership'] ? (
        <Notice tone="warning" title={serverErrors['transferOwnership']} action={transfer ? <Button onPress={() => setTransfer(false)}>{t('completeWithoutTransfer')}</Button> : undefined} />
      ) : null}
    </ConfirmDialog>
  );
}

/** DL-8 lose the deal (`deal.close`): a reason from the list; closed deals do not reopen. */
export function LoseDialog({ deal, onClose }: { deal: DealDto; onClose: () => void }) {
  const t = useTranslations('sales');
  const reasons = usePicklist('lost_reason');
  const action = useAction();
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [missing, setMissing] = useState(false);
  const ids = { reason: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const submit = () => {
    if (reason === '') {
      setMissing(true);
      return;
    }
    void action.run(() => bff(`deals/${deal.id}/lose`, { method: 'POST', version: deal.version, body: { lostReasonCode: reason, ...(notes.trim() ? { notes: notes.trim() } : {}) } }), t('lost', { reference: deal.reference }), onClose);
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('loseTitle', { reference: deal.reference })}
      consequence={deal.sale?.status === 'exchanged' ? t('loseConsequenceExchanged') : t('loseConsequence')}
      confirmLabel={t('lose')}
      onConfirm={submit}
      busy={action.busy}
      danger
    >
      <FormProblem error={action.error} clientErrors={missing ? { lostReasonCode: t('reasonRequired') } : {}} fields={{ lostReasonCode: { label: t('lostReason'), id: ids.reason } }} />
      <SelectField
        id={ids.reason}
        label={t('lostReason')}
        value={reason}
        onChange={(value) => {
          setReason(value);
          setMissing(false);
        }}
        placeholder={t('chooseReason')}
        options={(reasons.data?.data ?? []).map((value) => ({ id: value.code, label: value.label }))}
        isRequired
        error={missing ? t('reasonRequired') : serverErrors['lostReasonCode']}
      />
      <TextField label={t('notes')} value={notes} onChange={setNotes} multiline maxLength={2000} dir="auto" description={t('noIdNumbers')} />
    </ConfirmDialog>
  );
}
