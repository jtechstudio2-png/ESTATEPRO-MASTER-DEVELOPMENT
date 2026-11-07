'use client';

import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Notice, Skeleton } from '@/components/ui/feedback';
import { RadioGroupField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import type { ListingDto, ListingReadinessDto } from '@/lib/api-schema';
import { bffRequest } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { type ListingStatus, nextStatuses, reasonRequired, TERMINAL } from './listing-labels';
import styles from './listings.module.css';
import { useReadiness } from './use-listing';

export type ListingAction = 'publish' | 'unpublish' | 'status' | 'reassign' | 'relist' | 'archive' | 'restore';

/** Where each publishing blocker is fixed (L-5). */
export function blockerHref(
  listing: Pick<ListingDto, 'id' | 'property' | 'unit'>,
  { code, field }: Pick<ListingReadinessDto['blockers'][number], 'code' | 'field'>,
): string | null {
  switch (code) {
    case 'no-owner':
      return `/properties/${listing.property.id}/ownership`;
    case 'unverified': {
      // Issue #18: one item per owner; the field names the owner contact.
      const contactId = field.startsWith('sellerKyc.') ? field.slice('sellerKyc.'.length) : null;
      return contactId ? `/contacts/${contactId}/identity` : `/properties/${listing.property.id}/ownership`;
    }
    case 'photos':
      return `/listings/${listing.id}/gallery`;
    case 'floor-plan':
      return `/properties/${listing.property.id}/media?type=plans`;
    case 'expired':
    case 'missing':
      return `/listings/${listing.id}/edit`;
    case 'unavailable':
      return `/properties/${listing.property.id}/units?unit=${listing.unit.id}`;
    default:
      return null;
  }
}

/** The publishing checklist (L-3 side panel, L-5 dialog): every blocker with a link to fix it. */
export function PublishChecklist({ listing, readiness }: { listing: ListingDto; readiness: ListingReadinessDto | undefined }) {
  const t = useTranslations('listings.checklist');
  if (!readiness) return <Skeleton />;
  if (readiness.isPublished) return <p>{t('published')}</p>;
  if (readiness.blockers.length === 0) {
    return (
      <p className={styles.ok}>
        <span aria-hidden="true">✓ </span>
        {t('ready')}
      </p>
    );
  }
  return (
    <ul className={styles.checklist}>
      {readiness.blockers.map((blocker) => {
        const href = blockerHref(listing, blocker);
        return (
          <li key={`${blocker.code}-${blocker.field}`}>
            <span aria-hidden="true" className={styles.cross}>
              ✗{' '}
            </span>
            <span>
              <strong>{t(`code.${blocker.code}`)}</strong>: {blocker.message}
            </span>
            {href ? (
              <>
                {' '}
                <NextLink href={href}>{t('fix')}</NextLink>
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ListingDialogs({ listing, action, onClose }: { listing: ListingDto; action: ListingAction | null; onClose: () => void }) {
  if (action === null) return null;
  switch (action) {
    case 'publish':
    case 'unpublish':
      return <PublishDialog listing={listing} mode={action} onClose={onClose} />;
    case 'status':
      return <StatusDialog listing={listing} onClose={onClose} />;
    case 'reassign':
      return <ReassignDialog listing={listing} onClose={onClose} />;
    case 'relist':
      return <RelistDialog listing={listing} onClose={onClose} />;
    case 'archive':
    case 'restore':
      return <ArchiveDialog listing={listing} mode={action} onClose={onClose} />;
  }
}

/** Runs one listing action with If-Match; keeps the dialog open and shows the problem on failure. */
function useListingAction(listing: ListingDto, onClose: () => void) {
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body: unknown, message: string | ((data: ListingDto) => string), after?: (data: ListingDto) => void) => {
    setBusy(true);
    setError(null);
    try {
      const response = await bffRequest<ListingDto>(`listings/${listing.id}/${path}`, { method: 'POST', version: listing.version, body });
      announce(typeof message === 'string' ? message : message(response.data));
      await refresh();
      if (after) after(response.data);
      else onClose();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function Conflict({ error }: { error: unknown }) {
  const common = useTranslations('common');
  return error instanceof ApiError && error.status === 412 ? (
    <Notice tone="warning" title={common('conflictTitle')}>
      {common('conflictDetail')}
    </Notice>
  ) : null;
}

/** L-5: publish (disabled with the blockers listed) or unpublish. */
function PublishDialog({ listing, mode, onClose }: { listing: ListingDto; mode: 'publish' | 'unpublish'; onClose: () => void }) {
  const t = useTranslations('listings');
  const readiness = useReadiness(listing.id, mode === 'publish');
  const { error, busy, run } = useListingAction(listing, onClose);
  const blocked = mode === 'publish' && (readiness.data ? !readiness.data.canPublish : true);
  const fromDraft = listing.status === 'draft';
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={mode === 'publish' ? t('publishTitle', { reference: listing.reference }) : t('unpublishTitle', { reference: listing.reference })}
      consequence={mode === 'publish' ? (fromDraft ? t('publishConsequence') : t('publishLive')) : t('unpublishConsequence')}
      confirmLabel={mode === 'publish' ? t('publishConfirm', { reference: listing.reference }) : t('unpublishConfirm', { reference: listing.reference })}
      onConfirm={() => void run(mode, {}, mode === 'publish' ? t('publishedDone', { reference: listing.reference }) : t('unpublishedDone', { reference: listing.reference }))}
      busy={busy}
      canConfirm={!blocked}
    >
      <Conflict error={error} />
      {mode === 'publish' ? (
        <>
          <PublishChecklist listing={listing} readiness={readiness.data} />
          {blocked && readiness.data ? <p className={styles.hint}>{t('publishBlocked')}</p> : null}
        </>
      ) : null}
      {error && !(error instanceof ApiError && error.status === 412) ? <FormProblem error={error} fields={{}} /> : null}
    </ConfirmDialog>
  );
}

/** L-6: the next statuses the lifecycle allows; terminal ones state that the listing closes. */
function StatusDialog({ listing, onClose }: { listing: ListingDto; onClose: () => void }) {
  const t = useTranslations('listings');
  const options = nextStatuses(listing.listingType, listing.status);
  const [to, setTo] = useState<ListingStatus | null>(options[0] ?? null);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const { error, busy, run } = useListingAction(listing, onClose);
  const reasonId = useId();
  const needsReason = to !== null && reasonRequired(listing.status, to);
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('statusTitle', { status: t(`statusValue.${listing.status}`) })}
      consequence={options.length === 0 ? t('noTransitions', { status: t(`statusValue.${listing.status}`) }) : listing.status === 'draft' ? t('draftHint') : ''}
      confirmLabel={to ? `${t('statusConfirm')}: ${t(`statusValue.${to}`)}` : t('statusConfirm')}
      danger={to !== null && TERMINAL.includes(to)}
      canConfirm={to !== null}
      busy={busy}
      onConfirm={() => {
        if (to === null) return;
        if (needsReason && reason.trim() === '') {
          setMissing(true);
          return;
        }
        void run('status-transitions', { toStatus: to, ...(reason.trim() ? { reason: reason.trim() } : {}) }, t('statusDone', { status: t(`statusValue.${to}`) }));
      }}
    >
      <Conflict error={error} />
      {error && !(error instanceof ApiError && error.status === 412) ? <FormProblem error={error} fields={{ reason: { label: t('reason'), id: reasonId } }} /> : null}
      {options.length > 0 ? (
        <>
          <RadioGroupField label={t('newStatus')} value={to ?? ''} onChange={(value) => setTo(value as ListingStatus)} options={options.map((id) => ({ id, label: t(`statusValue.${id}`) }))} />
          <TextField
            id={reasonId}
            label={t('reason')}
            value={reason}
            onChange={(value) => {
              setReason(value);
              setMissing(false);
            }}
            isRequired={needsReason}
            description={t('reasonHint')}
            maxLength={500}
            dir="auto"
            error={missing ? t('reasonHint') : fieldErrorsOf(error)['reason']}
          />
          {to !== null && TERMINAL.includes(to) ? <Notice tone="warning">{t('terminalNote')}</Notice> : null}
        </>
      ) : null}
    </ConfirmDialog>
  );
}

/** L-7: managers and administrators only (listing.update with office or all scope). */
function ReassignDialog({ listing, onClose }: { listing: ListingDto; onClose: () => void }) {
  const t = useTranslations('listings');
  const [agent, setAgent] = useState<PickedMember | null>(null);
  const [note, setNote] = useState('');
  const { error, busy, run } = useListingAction(listing, onClose);
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('reassignTitle', { reference: listing.reference })}
      consequence={t('currentAgent', { name: listing.agent.displayName })}
      confirmLabel={t('reassignConfirm')}
      canConfirm={agent !== null && agent.membershipId !== listing.agent.membershipId}
      busy={busy}
      onConfirm={() =>
        agent && void run('assign', { agentMembershipId: agent.membershipId, ...(note.trim() ? { reason: note.trim() } : {}) }, t('reassignDone', { reference: listing.reference, name: agent.displayName }))
      }
    >
      <Conflict error={error} />
      {error && !(error instanceof ApiError && error.status === 412) ? <FormProblem error={error} fields={{}} /> : null}
      <PeoplePicker label={t('newAgent')} value={agent} onChange={setAgent} permission="listing.update" officeId={listing.office.id} isRequired error={fieldErrorsOf(error)['agentMembershipId']} />
      <TextField label={t('note')} value={note} onChange={setNote} maxLength={500} dir="auto" />
    </ConfirmDialog>
  );
}

/** L-8: a new draft from a closed listing; opens it. */
function RelistDialog({ listing, onClose }: { listing: ListingDto; onClose: () => void }) {
  const t = useTranslations('listings');
  const format = useFormat();
  const router = useRouter();
  const { grant, session } = useSession();
  const ownOnly = grant('listing.create')?.scope === 'own';
  const [agent, setAgent] = useState<PickedMember | null>(ownOnly ? { membershipId: session.membershipId, displayName: session.user.displayName } : { membershipId: listing.agent.membershipId, displayName: listing.agent.displayName });
  const { error, busy, run } = useListingAction(listing, onClose);
  const conflict = error instanceof ApiError && error.status === 409 ? error.problem.conflictingResource : undefined;
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('relistTitle', { unit: listing.unit.unitLabel, type: t(`type.${listing.listingType}`) })}
      consequence={
        <>
          {t('relistIntro', { reference: listing.reference, status: t(`statusValue.${listing.status}`), date: listing.closedAt ? format.date(listing.closedAt) : '' })} {t('relistCopies')}
        </>
      }
      confirmLabel={t('relistConfirm')}
      busy={busy}
      onConfirm={() =>
        void run('relist', ownOnly || !agent ? {} : { agentMembershipId: agent.membershipId }, (created) => t('relistDone', { reference: created.reference }), (created) => {
          onClose();
          router.push(`/listings/${created.id}`);
        })
      }
    >
      {conflict ? (
        <Notice tone="warning" title={t('new.conflict', { type: t(`type.${listing.listingType}`) })} action={<NextLink href={`/listings/${conflict.id}`}>{t('new.openExisting')}</NextLink>} />
      ) : error ? (
        <FormProblem error={error} fields={{}} />
      ) : null}
      {ownOnly ? null : <PeoplePicker label={t('agent')} value={agent} onChange={setAgent} permission="listing.update" officeId={listing.office.id} />}
    </ConfirmDialog>
  );
}

function ArchiveDialog({ listing, mode, onClose }: { listing: ListingDto; mode: 'archive' | 'restore'; onClose: () => void }) {
  const t = useTranslations('listings');
  const common = useTranslations('common');
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const { error, busy, run } = useListingAction(listing, onClose);
  const reasonId = useId();
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={mode === 'archive' ? t('archiveTitle', { reference: listing.reference }) : t('restoreTitle', { reference: listing.reference })}
      consequence={mode === 'archive' ? t('archiveConsequence') : t('restoreConsequence')}
      confirmLabel={mode === 'archive' ? t('archiveConfirm', { reference: listing.reference }) : t('restoreConfirm', { reference: listing.reference })}
      danger={mode === 'archive'}
      busy={busy}
      onConfirm={() => {
        if (mode === 'archive' && reason.trim() === '') {
          setMissing(true);
          return;
        }
        void run(mode, mode === 'archive' ? { reason: reason.trim() } : {}, mode === 'archive' ? t('archivedDone', { reference: listing.reference }) : t('restoredDone', { reference: listing.reference }));
      }}
    >
      <Conflict error={error} />
      {error && !(error instanceof ApiError && error.status === 412) ? <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} /> : null}
      {mode === 'archive' ? (
        <TextField
          id={reasonId}
          label={common('reason')}
          value={reason}
          onChange={(value) => {
            setReason(value);
            setMissing(false);
          }}
          isRequired
          maxLength={500}
          dir="auto"
          error={missing ? common('reasonRequired') : fieldErrorsOf(error)['reason']}
        />
      ) : null}
    </ConfirmDialog>
  );
}
