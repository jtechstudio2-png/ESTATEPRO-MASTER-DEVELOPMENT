'use client';

import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { Ltr } from '@/components/crm/labels';
import { ContactSearch } from '@/components/leads/new-lead';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { FieldRow, RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Panel } from '@/components/ui/layout';
import { FilterSelect, LoadMore } from '@/components/ui/list-controls';
import { When } from '@/components/ui/when';
import type { ContactSummaryDto, DealDto, OfferDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { usePagedList } from '@/lib/hooks/paged-list';
import { usePicklist } from '@/lib/hooks/reference';
import { zonedToInstant } from '@/lib/time';

import { MoneyText, OfferStatusLabel } from './sales-labels';
import styles from './sales.module.css';
import { offerThreads } from './sales-rules';
import { useAction, useDealOffers } from './use-sales';

const AMOUNT = /^\d{1,13}(\.\d{1,4})?$/;
const RENT_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;
const BUYER_ROLES = new Set(['buyer', 'tenant']);
const SELLER_ROLES = new Set(['seller', 'landlord']);
const OPEN = new Set(['submitted', 'countered']);

type OfferDialog = { kind: 'record' } | { kind: 'counter' | 'accept' | 'reject' | 'withdraw'; offer: OfferDto } | null;

/**
 * O-1 negotiation on a deal: offers as threads (each answer under the offer it
 * answers), with the actions the API allows on each (O-2, O-3). Amounts never
 * change once saved; a change is a counter-offer.
 */
export function OffersPanel({ deal }: { deal: DealDto }) {
  const t = useTranslations('sales');
  const { can, readOnly } = useSession();
  const format = useFormat();
  const financing = usePicklist('financing');
  const offers = useDealOffers(deal.id);
  const [dialog, setDialog] = useState<OfferDialog>(null);
  const open = deal.status === 'open' && !readOnly;
  const canRecord = open && can('offer.manage') && deal.listing !== null;
  const rows = offers.data ? offerThreads(offers.data.data) : [];
  const answered = new Map((offers.data?.data ?? []).map((offer) => [offer.id, offer]));
  const otherAccepted = (offers.data?.data ?? []).some((offer) => offer.otherOfferAccepted);
  const financingLabel = (code: string) => financing.data?.data.find((value) => value.code === code)?.label ?? code;

  return (
    <Panel
      title={t('offersOnDeal', { reference: deal.reference })}
      actions={
        canRecord ? (
          <Button variant="primary" onPress={() => setDialog({ kind: 'record' })}>
            {t('recordOffer')}
          </Button>
        ) : undefined
      }
    >
      <RefreshBar active={offers.isFetching && !offers.isPending} />
      {deal.listing === null ? <Notice tone="info" title={t('offersNeedListing')} /> : null}
      {otherAccepted ? <Notice tone="warning" title={t('otherOfferAccepted')} /> : null}
      {open && can('offer.manage') && !can('offer.accept') ? <p className={styles.meta}>{t('whoAccepts')}</p> : null}
      {offers.isPending ? (
        <Skeleton />
      ) : offers.isError ? (
        <ErrorNotice error={offers.error} onRetry={() => void offers.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('noOffers')} headingLevel={3}>
          {t('noOffersDetail')}
        </EmptyState>
      ) : (
        <ol className={styles.thread} aria-label={t('offerChain')}>
          {rows.map(({ offer, depth }) => {
            const parent = offer.parentOfferId ? answered.get(offer.parentOfferId) : undefined;
            const live = open && OPEN.has(offer.status);
            return (
              <li key={offer.id} style={{ ['--depth' as string]: depth }}>
                <span className={styles.inline}>
                  {parent ? (
                    <span className={styles.meta}>
                      <span aria-hidden="true">└ </span>
                      {t('answers', { amount: format.money(parent.amount) })}
                    </span>
                  ) : null}
                  <strong>
                    <MoneyText money={offer.amount} />
                  </strong>
                  {offer.rentFrequency ? <span>{t(`rentFrequency.${offer.rentFrequency}`)}</span> : null}
                  <span>{offer.direction === 'from_buyer' ? t('fromBuyer', { name: offer.offeredBy.name }) : t('fromSeller', { name: offer.offeredBy.name })}</span>
                  <OfferStatusLabel status={offer.status} />
                </span>
                <span className={styles.meta}>
                  <When iso={offer.submittedAt} />
                  {offer.financingCode ? ` · ${financingLabel(offer.financingCode)}` : ''}
                  {offer.expiresAt ? ` · ${t('expires', { date: format.dateTime(offer.expiresAt) })}` : ''}
                  {` · ${t('recordedBy', { name: offer.recordedBy.name })}`}
                </span>
                {offer.conditions ? (
                  <span className={styles.body} dir="auto">
                    {offer.conditions}
                  </span>
                ) : null}
                {offer.otherOfferAccepted && OPEN.has(offer.status) ? (
                  <span>
                    <span aria-hidden="true">⚑ </span>
                    {t('flagOtherAccepted')}
                  </span>
                ) : null}
                <span className={styles.actions}>
                  {live && offer.canManage ? (
                    <Button size="small" onPress={() => setDialog({ kind: 'counter', offer })} aria-label={t('counterNamed', { amount: format.money(offer.amount) })}>
                      {t('counter')}
                    </Button>
                  ) : null}
                  {live && offer.canAccept ? (
                    <Button size="small" variant="primary" onPress={() => setDialog({ kind: 'accept', offer })} aria-label={t('acceptNamed', { amount: format.money(offer.amount) })}>
                      {t('accept')}
                    </Button>
                  ) : null}
                  {live && offer.canManage ? (
                    <Button size="small" onPress={() => setDialog({ kind: 'reject', offer })} aria-label={t('rejectNamed', { amount: format.money(offer.amount) })}>
                      {t('reject')}
                    </Button>
                  ) : null}
                  {open && offer.canManage && (OPEN.has(offer.status) || offer.status === 'accepted') ? (
                    <Button size="small" variant="quiet" onPress={() => setDialog({ kind: 'withdraw', offer })} aria-label={t('withdrawNamed', { amount: format.money(offer.amount) })}>
                      {t('withdraw')}
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {dialog?.kind === 'record' ? <OfferFormDialog deal={deal} parent={null} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'counter' ? <OfferFormDialog deal={deal} parent={dialog.offer} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'accept' ? <AcceptOfferDialog deal={deal} offer={dialog.offer} openOthers={(offers.data?.data ?? []).filter((offer) => offer.id !== dialog.offer.id && OPEN.has(offer.status)).length} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'reject' || dialog?.kind === 'withdraw' ? <OfferReasonDialog offer={dialog.offer} mode={dialog.kind} onClose={() => setDialog(null)} /> : null}
    </Panel>
  );
}

/** O-2 record an offer, or counter one (direction fixed to the other side). */
function OfferFormDialog({ deal, parent, onClose }: { deal: DealDto; parent: OfferDto | null; onClose: () => void }) {
  const t = useTranslations('sales');
  const format = useFormat();
  const { session } = useSession();
  const financing = usePicklist('financing');
  const action = useAction();
  const [direction, setDirection] = useState<'from_buyer' | 'from_seller'>(parent ? (parent.direction === 'from_buyer' ? 'from_seller' : 'from_buyer') : 'from_buyer');
  const sideParties = deal.parties.filter((party) => (direction === 'from_buyer' ? BUYER_ROLES.has(party.partyRole) || party.isPrimary : SELLER_ROLES.has(party.partyRole)));
  const unique = [...new Map(sideParties.map((party) => [party.contact.id, party])).values()];
  const [offeredBy, setOfferedBy] = useState<string>(unique[0]?.contact.id ?? '');
  const [searched, setSearched] = useState<ContactSummaryDto | null>(null);
  const currency = parent?.amount.currency ?? deal.expectedValue?.currency ?? session.company.baseCurrencyCode;
  const [amount, setAmount] = useState('');
  const [rent, setRent] = useState<string>(deal.dealType === 'letting' ? (parent?.rentFrequency ?? 'monthly') : '');
  const [financingCode, setFinancingCode] = useState('');
  const [expires, setExpires] = useState('');
  const [conditions, setConditions] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const ids = { from: useId(), amount: useId(), expires: useId(), conditions: useId() };
  const serverErrors = fieldErrorsOf(action.error);
  const fieldError = (key: string) => clientErrors[key] ?? serverErrors[key];
  const chosen = unique.length > 0 ? offeredBy : (searched?.id ?? '');

  const submit = () => {
    const errors: Record<string, string> = {};
    if (chosen === '') errors['offeredByContactId'] = t('offerorRequired');
    if (!AMOUNT.test(amount) || Number(amount) <= 0) errors['amount'] = t('amountInvalid');
    const expiresAt = expires ? zonedToInstant(expires, session.timezone) : null;
    if (expires && expiresAt === null) errors['expiresAt'] = t('dateInvalid');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const body = {
      offeredByContactId: chosen,
      amount: { amount, currency },
      ...(deal.dealType === 'letting' && rent ? { rentFrequency: rent } : {}),
      ...(financingCode ? { financingCode } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(conditions.trim() ? { conditions: conditions.trim() } : {}),
    };
    void action.run(
      () => (parent ? bff(`offers/${parent.id}/counter`, { method: 'POST', version: parent.version, body }) : bff('offers', { method: 'POST', body: { ...body, dealId: deal.id, direction } })),
      parent ? t('counterRecorded') : t('offerRecorded'),
      onClose,
    );
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={parent ? t('counterTitle', { amount: format.money(parent.amount) }) : t('recordOffer')}
      consequence={t('offerConsequence')}
      confirmLabel={t('save')}
      onConfirm={submit}
      busy={action.busy}
    >
      <FormProblem
        error={action.error}
        clientErrors={clientErrors}
        fields={{ offeredByContactId: { label: t('offerFrom'), id: ids.from }, amount: { label: t('amount'), id: ids.amount }, expiresAt: { label: t('expiresAt'), id: ids.expires }, conditions: { label: t('conditions'), id: ids.conditions } }}
      />
      {parent ? (
        <p>{direction === 'from_buyer' ? t('counterFromBuyer') : t('counterFromSeller')}</p>
      ) : (
        <RadioGroupField
          label={t('direction')}
          value={direction}
          onChange={(value) => {
            setDirection(value as 'from_buyer' | 'from_seller');
            setOfferedBy('');
            setSearched(null);
          }}
          options={[
            { id: 'from_buyer', label: deal.dealType === 'sale' ? t('directionBuyer') : t('directionTenant') },
            { id: 'from_seller', label: deal.dealType === 'sale' ? t('directionSeller') : t('directionLandlord') },
          ]}
        />
      )}
      {unique.length > 0 ? (
        <SelectField id={ids.from} label={t('offerFrom')} value={offeredBy} onChange={setOfferedBy} options={unique.map((party) => ({ id: party.contact.id, label: party.contact.name }))} isRequired error={fieldError('offeredByContactId')} />
      ) : (
        <ContactSearch value={searched} onChange={setSearched} labelId={ids.from} label={t('offerFrom')} help={t('sellerSideHelp')} error={fieldError('offeredByContactId')} />
      )}
      <FieldRow>
        <TextField label={t('currency')} value={currency} onChange={() => undefined} isDisabled dir="ltr" />
        <TextField id={ids.amount} label={t('amount')} value={amount} onChange={setAmount} inputMode="decimal" dir="ltr" isRequired error={fieldError('amount') ?? serverErrors['amount.amount']} />
      </FieldRow>
      {deal.dealType === 'letting' ? <SelectField label={t('rentFrequencyLabel')} value={rent} onChange={setRent} options={RENT_FREQUENCIES.map((id) => ({ id, label: t(`rentFrequency.${id}`) }))} /> : null}
      <FieldRow>
        <SelectField label={t('financing')} value={financingCode} onChange={setFinancingCode} options={[{ id: '', label: t('notStated') }, ...(financing.data?.data ?? []).map((value) => ({ id: value.code, label: value.label }))]} />
        <TextField id={ids.expires} label={t('expiresAt')} type="datetime-local" value={expires} onChange={setExpires} description={t('inTimeZone', { zone: session.timezone })} error={fieldError('expiresAt')} />
      </FieldRow>
      <TextField id={ids.conditions} label={t('conditions')} value={conditions} onChange={setConditions} multiline maxLength={2000} dir="auto" description={t('conditionsHelp')} error={fieldError('conditions')} />
    </ConfirmDialog>
  );
}

/** O-3 accept: the consequences spelled out before confirming. */
function AcceptOfferDialog({ deal, offer, openOthers, onClose }: { deal: DealDto; offer: OfferDto; openOthers: number; onClose: () => void }) {
  const t = useTranslations('sales');
  const format = useFormat();
  const action = useAction();
  const submit = () => void action.run(() => bff(`offers/${offer.id}/accept`, { method: 'POST', version: offer.version }), t('offerAccepted', { amount: format.money(offer.amount) }), onClose);
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('acceptTitle', { amount: format.money(offer.amount), name: offer.offeredBy.name })}
      consequence={
        <ul>
          <li>{t('acceptMoves')}</li>
          {deal.listing ? <li>{t('acceptListing', { reference: deal.listing.reference })}</li> : null}
          {deal.dealType === 'sale' ? <li>{t('acceptIdentity')}</li> : null}
          {openOthers > 0 ? <li>{t('acceptOthers', { count: openOthers })}</li> : null}
        </ul>
      }
      confirmLabel={t('accept')}
      onConfirm={submit}
      busy={action.busy}
    >
      <FormProblem error={action.error} fields={{}} />
    </ConfirmDialog>
  );
}

/** O-3 reject or withdraw; withdrawing an accepted offer needs a reason. */
function OfferReasonDialog({ offer, mode, onClose }: { offer: OfferDto; mode: 'reject' | 'withdraw'; onClose: () => void }) {
  const t = useTranslations('sales');
  const format = useFormat();
  const action = useAction();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const required = mode === 'withdraw' && offer.status === 'accepted';
  const ids = { reason: useId() };
  const submit = () => {
    if (required && reason.trim() === '') {
      setMissing(true);
      return;
    }
    void action.run(
      () => bff(`offers/${offer.id}/${mode}`, { method: 'POST', version: offer.version, body: reason.trim() ? { reason: reason.trim() } : {} }),
      mode === 'reject' ? t('offerRejected', { amount: format.money(offer.amount) }) : t('offerWithdrawn', { amount: format.money(offer.amount) }),
      onClose,
    );
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={mode === 'reject' ? t('rejectTitle', { amount: format.money(offer.amount) }) : t('withdrawTitle', { amount: format.money(offer.amount) })}
      consequence={required ? t('withdrawAcceptedConsequence') : mode === 'reject' ? t('rejectConsequence') : t('withdrawConsequence')}
      confirmLabel={mode === 'reject' ? t('reject') : t('withdraw')}
      onConfirm={submit}
      busy={action.busy}
      danger
    >
      <FormProblem error={action.error} clientErrors={missing ? { reason: t('reasonRequired') } : {}} fields={{ reason: { label: t('reason'), id: ids.reason } }} />
      <TextField id={ids.reason} label={t('reason')} value={reason} onChange={setReason} multiline maxLength={500} dir="auto" isRequired={required} description={t('noIdNumbers')} error={missing ? t('reasonRequired') : undefined} />
    </ConfirmDialog>
  );
}

/** O-4 listing offers tab and the contact's "Offers made" panel (X-C2): rows only for deals in scope. */
export function OfferList({ listingId, contactId }: { listingId?: string; contactId?: string }) {
  const t = useTranslations('sales');
  const [status, setStatus] = useState<string | null>(listingId ? 'submitted,countered,accepted' : null);
  const query = new URLSearchParams({ sort: '-submittedAt' });
  if (listingId) query.set('filter[listingId]', listingId);
  if (contactId) query.set('filter[contactId]', contactId);
  if (status) query.set('filter[status]', status);
  const result = usePagedList<OfferDto>('offers', query, { limit: 20 });
  return (
    <Panel title={contactId ? t('offersMade') : t('offersTitle')}>
      {listingId ? (
        <FilterSelect
          label={t('status')}
          value={status}
          onChange={setStatus}
          options={[
            { id: 'submitted,countered,accepted', label: t('offerFilterLive') },
            { id: 'rejected,withdrawn,expired', label: t('offerFilterClosed') },
          ]}
        />
      ) : null}
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <Skeleton />
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState title={t('noOffers')} headingLevel={3}>
          {t('noOffersHere')}
        </EmptyState>
      ) : (
        <DataTable
          caption={contactId ? t('offersMade') : t('offersTitle')}
          rows={result.rows}
          rowKey={(row) => row.id}
          identifier={{
            header: t('amount'),
            href: (row) => `/deals/${row.deal.id}?tab=offers`,
            label: (row) => <MoneyText money={row.amount} />,
            secondary: (row) => (
              <>
                <bdi dir="auto">{row.offeredBy.name}</bdi> · <Ltr>{row.deal.reference}</Ltr>
              </>
            ),
          }}
          status={{
            header: t('status'),
            cell: (row) => (
              <span className={styles.inline}>
                <OfferStatusLabel status={row.status} />
                {row.otherOfferAccepted && OPEN.has(row.status) ? (
                  <span>
                    <span aria-hidden="true">⚑ </span>
                    {t('flagOtherAccepted')}
                  </span>
                ) : null}
              </span>
            ),
          }}
          columns={[
            { key: 'submitted', header: t('submitted'), cell: (row) => <When iso={row.submittedAt} />, onCard: true },
            {
              key: 'listing',
              header: t('listing'),
              cell: (row) => (
                <NextLink href={`/listings/${row.listing.id}`}>
                  <Ltr>{row.listing.reference}</Ltr>
                </NextLink>
              ),
            },
          ]}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
    </Panel>
  );
}
