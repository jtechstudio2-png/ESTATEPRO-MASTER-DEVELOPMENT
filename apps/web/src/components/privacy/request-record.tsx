'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import contactStyles from '@/components/contacts/contacts.module.css';
import { ContactName, Ltr } from '@/components/crm/labels';
import { downloadExport } from '@/components/exports/export-dialog';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Facts, Page, PageHeader, Panel, RecordLayout } from '@/components/ui/layout';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { When } from '@/components/ui/when';
import type { PrivacyRequestDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useDocumentTitle } from '@/lib/hooks/document-title';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { DueLabel, PrivacyStatusLabel } from './labels';

type Dialog = 'verify' | 'status' | 'assign' | 'extend' | 'evidence' | 'report' | 'erase' | null;
const METHODS = ['documents_seen', 'known_contact_details', 'email_confirmation', 'other'] as const;
const KINDS = ['request', 'identity', 'correspondence', 'response', 'other'] as const;

export function usePrivacyRequest(id: string) {
  return useQuery({ queryKey: ['record', 'privacy-request', id], queryFn: () => bff<PrivacyRequestDto>(`privacy-requests/${id}`) });
}

/**
 * One data-subject request (gap G3): who asked, when it is due, how identity
 * was verified, evidence, history, and fulfilment. Carrying out an erasure or
 * producing an access report needs privacy.fulfil and a recent second-factor
 * sign-in; erasure also asks the member to type ERASE.
 */
export function PrivacyRequestRecord({ id }: { id: string }) {
  const t = useTranslations('privacy');
  const errors = useTranslations('errors');
  const format = useFormat();
  const { can, readOnly } = useSession();
  const request = usePrivacyRequest(id);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  useDocumentTitle(request.data ? `${request.data.reference} · ${t('registerTitle')}` : null);

  if (request.isPending) {
    return (
      <Page>
        <div aria-busy="true">
          <Skeleton width="40%" />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (request.isError) {
    return (
      <Page>
        {request.error instanceof ApiError && request.error.status === 404 ? (
          <EmptyState title={t('notFound')} action={<LinkButton href="/privacy-requests">{t('backToList')}</LinkButton>}>
            {errors('notFoundDetail')}
          </EmptyState>
        ) : (
          <ErrorNotice error={request.error} onRetry={() => void request.refetch()} />
        )}
      </Page>
    );
  }

  const record = request.data;
  const open = record.closedAt === null;
  const manage = record.canManage && !readOnly && open;
  const mayFulfil = can('privacy.fulfil') && !readOnly;
  const report = record.accessReport;

  return (
    <Page>
      <PageHeader
        back={{ href: '/privacy-requests', label: t('backToList') }}
        title={
          <>
            <Ltr>{record.reference}</Ltr> · {t(`type.${record.requestType}`)}
          </>
        }
        subtitle={
          <>
            <PrivacyStatusLabel status={record.status} />
            <span aria-hidden="true">·</span>
            <span>
              {t('dueOn')} <span className="ep-num">{format.date(record.dueOn)}</span> <DueLabel row={record} />
            </span>
            <span aria-hidden="true">·</span>
            <span>{record.assignedTo ? <bdi>{record.assignedTo.name}</bdi> : t('unassigned')}</span>
          </>
        }
        actions={
          manage ? (
            <>
              {!record.identityVerified ? (
                <Button variant="primary" onPress={() => setDialog('verify')}>
                  {t('verifyIdentity')}
                </Button>
              ) : null}
              {record.nextStatuses.length > 0 ? <Button onPress={() => setDialog('status')}>{t('changeStatus')}</Button> : null}
              <Button onPress={() => setDialog('assign')}>{t('assign')}</Button>
              {record.extensionReason === null ? <Button onPress={() => setDialog('extend')}>{t('extend')}</Button> : null}
            </>
          ) : null
        }
      />
      <RecordLayout
        asideLabel={t('details')}
        main={
          <>
            <Panel title={t('fulfilTitle')}>
              {record.status === 'completed' && record.requestType === 'erasure' ? (
                <Notice tone="success" title={t('erasedLine')} />
              ) : !open ? (
                <p>{record.outcomeNote ? <bdi dir="auto">{record.outcomeNote}</bdi> : t(`status.${record.status}`)}</p>
              ) : record.status !== 'in_progress' ? (
                <p>{t('fulfilNeedsWork')}</p>
              ) : record.requestType === 'erasure' ? (
                <>
                  {record.erasureBlockers.length > 0 ? (
                    <Notice tone="warning" title={t('blockedTitle')}>
                      <ul>
                        {record.erasureBlockers.map((code) => (
                          <li key={code}>{code === 'organisation' ? t('blocker.organisation') : code === 'open_deal' ? t('blocker.openDeal') : code === 'sale_record' ? t('blocker.saleRecord') : t('blocker.records', { records: code.replace(/_/g, ' ') })}</li>
                        ))}
                      </ul>
                      <p>{t('blockedHelp')}</p>
                    </Notice>
                  ) : null}
                  {mayFulfil ? (
                    record.canFulfil ? (
                      <Button variant="danger" onPress={() => setDialog('erase')}>
                        {t('erase')}
                      </Button>
                    ) : null
                  ) : (
                    <p>{t('fulfilNotAllowed')}</p>
                  )}
                </>
              ) : (
                <>
                  {report ? (
                    report.status === 'completed' ? (
                      <p>
                        {t('reportReady', { date: format.dateTime(report.expiresAt ?? '') })}{' '}
                        {report.canDownload ? (
                          <Button
                            size="small"
                            onPress={() => {
                              setDownloadError(null);
                              void downloadExport(report.exportId).catch(setDownloadError);
                            }}
                          >
                            {t('download')}
                          </Button>
                        ) : (
                          <span className={contactStyles.meta}>{t('reportNotYours')}</span>
                        )}
                      </p>
                    ) : (
                      <p>{t('reportExpired')}</p>
                    )
                  ) : null}
                  {downloadError ? <ErrorNotice error={downloadError} /> : null}
                  {mayFulfil ? (
                    <Button variant={report ? 'secondary' : 'primary'} onPress={() => setDialog('report')}>
                      {t('generateReport')}
                    </Button>
                  ) : (
                    <p>{t('fulfilNotAllowed')}</p>
                  )}
                </>
              )}
            </Panel>
            <Panel title={t('evidence')} actions={record.canManage && !readOnly ? <Button size="small" onPress={() => setDialog('evidence')}>{t('addEvidence')}</Button> : null}>
              {record.evidence.length === 0 ? (
                <p>{t('noEvidence')}</p>
              ) : (
                <ol className={contactStyles.list}>
                  {record.evidence.map((item) => (
                    <li key={item.id}>
                      <span className={contactStyles.itemMain}>
                        <strong>{t(`evidenceKind.${item.kind}`)}</strong>
                        <span className={contactStyles.body} dir="auto">
                          {item.summary}
                        </span>
                        <span className={contactStyles.meta}>{t('evidenceBy', { date: format.date(item.receivedOn), name: item.recordedBy.name })}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
            <Panel title={t('history')}>
              <ol className={contactStyles.list}>
                {[...record.history].reverse().map((event) => (
                  <li key={event.id}>
                    <span className={contactStyles.itemMain}>
                      <span>{t(`event.${event.eventType}`, { to: event.toStatus ? t(`status.${event.toStatus}`) : '' })}</span>
                      <span className={contactStyles.meta}>
                        <When iso={event.occurredAt} /> {event.actor ? `· ${t('byName', { name: event.actor.name })}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </Panel>
          </>
        }
        aside={
          <Panel title={t('details')}>
            <Facts
              items={[
                {
                  label: t('person'),
                  value: (
                    <NextLink href={`/contacts/${record.contact.id}`}>
                      <ContactName name={record.contact.name} /> {record.contact.reference ? <Ltr>{record.contact.reference}</Ltr> : null}
                    </NextLink>
                  ),
                },
                { label: t('typeHeader'), value: t(`typeLong.${record.requestType}`) },
                { label: t('channelLabel'), value: t(`channel.${record.channel as 'email'}`) },
                { label: t('receivedOn'), value: <span className="ep-num">{format.date(record.receivedOn)}</span> },
                {
                  label: t('dueOn'),
                  value: (
                    <span>
                      <span className="ep-num">{format.date(record.dueOn)}</span>
                      {record.extensionReason ? (
                        <>
                          <br />
                          <span className={contactStyles.meta}>{t('originalDue', { date: format.date(record.originalDueOn) })}</span>
                          <br />
                          <span className={contactStyles.meta} dir="auto">
                            {t('extendedBecause', { reason: record.extensionReason })}
                          </span>
                        </>
                      ) : null}
                    </span>
                  ),
                },
                {
                  label: t('identity'),
                  value:
                    record.identityVerifiedAt && record.identityMethod
                      ? t('verifiedBy', { method: t(`identityMethod.${record.identityMethod as 'other'}`), name: record.identityVerifiedBy?.name ?? '', date: format.date(record.identityVerifiedAt) })
                      : t('identityNotVerified'),
                },
                record.closedAt ? { label: t('outcome'), value: t('closedBy', { name: record.closedBy?.name ?? '', date: format.date(record.closedAt) }) } : null,
              ]}
            />
          </Panel>
        }
      />
      {dialog === 'verify' ? <VerifyDialog record={record} onClose={() => setDialog(null)} /> : null}
      {dialog === 'status' ? <StatusDialog record={record} onClose={() => setDialog(null)} /> : null}
      {dialog === 'assign' ? <AssignDialog record={record} onClose={() => setDialog(null)} /> : null}
      {dialog === 'extend' ? <ExtendDialog record={record} onClose={() => setDialog(null)} /> : null}
      {dialog === 'evidence' ? <EvidenceDialog record={record} onClose={() => setDialog(null)} /> : null}
      {dialog === 'report' ? (
        <ActionDialog
          record={record}
          path="access-report"
          title={t('reportTitle', { reference: record.reference })}
          consequence={t('reportConsequence')}
          confirmLabel={t('generateReport')}
          done={t('reportProduced', { reference: record.reference })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'erase' ? (
        <ActionDialog
          record={record}
          path="erase"
          body={{ confirm: 'ERASE' }}
          title={t('eraseTitle')}
          consequence={t('eraseConsequence')}
          confirmLabel={t('erase')}
          confirmWord="ERASE"
          danger
          done={t('erased', { reference: record.reference })}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Page>
  );
}

/** Shared submit logic: POST with the request's version; 412 refreshes; success announces and closes. */
function useAction(record: PrivacyRequestDto, onClose: () => void) {
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body: object, done: string, versioned = true) => {
    setBusy(true);
    setError(null);
    try {
      await bff(`privacy-requests/${record.id}/${path}`, { method: 'POST', ...(versioned ? { version: record.version } : {}), body });
      announce(done);
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function ActionDialog({
  record,
  path,
  body = {},
  title,
  consequence,
  confirmLabel,
  confirmWord,
  danger = false,
  done,
  onClose,
}: {
  record: PrivacyRequestDto;
  path: string;
  body?: object;
  title: string;
  consequence: string;
  confirmLabel: string;
  confirmWord?: string;
  danger?: boolean;
  done: string;
  onClose: () => void;
}) {
  const { error, busy, run } = useAction(record, onClose);
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}
      title={title}
      consequence={consequence}
      confirmLabel={confirmLabel}
      onConfirm={() => void run(path, body, done)}
      busy={busy}
      danger={danger}
      {...(confirmWord ? { confirmWord } : {})}
    >
      {error ? <ErrorNotice error={error} /> : null}
    </ConfirmDialog>
  );
}

function VerifyDialog({ record, onClose }: { record: PrivacyRequestDto; onClose: () => void }) {
  const t = useTranslations('privacy');
  const { error, busy, run } = useAction(record, onClose);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('documents_seen');
  const [note, setNote] = useState('');
  const noteId = useId();
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}
      title={t('verifyTitle')}
      consequence={t('verifyConsequence')}
      confirmLabel={t('verifyIdentity')}
      onConfirm={() => void run('verify-identity', { method, ...(note.trim() ? { note: note.trim() } : {}) }, t('verified', { reference: record.reference }))}
      busy={busy}
    >
      <FormProblem error={error} fields={{ note: { label: t('note'), id: noteId } }} />
      <SelectField label={t('method')} value={method} onChange={(value) => setMethod(value as (typeof METHODS)[number])} options={METHODS.map((id) => ({ id, label: t(`identityMethod.${id}`) }))} />
      <TextField id={noteId} label={t('note')} description={t('noteHelp')} value={note} onChange={setNote} multiline maxLength={1000} dir="auto" error={fieldErrorsOf(error)['note']} />
    </ConfirmDialog>
  );
}

function StatusDialog({ record, onClose }: { record: PrivacyRequestDto; onClose: () => void }) {
  const t = useTranslations('privacy');
  const { error, busy, run } = useAction(record, onClose);
  const [status, setStatus] = useState<string>(record.nextStatuses[0] ?? 'verifying');
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const noteId = useId();
  const needsNote = status === 'refused' || status === 'withdrawn';
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}
      title={t('statusTitle', { reference: record.reference })}
      consequence={t('statusConsequence')}
      confirmLabel={t('changeStatus')}
      onConfirm={() => {
        if (needsNote && note.trim() === '') {
          setMissing(true);
          return;
        }
        void run('status', { status, ...(note.trim() ? { note: note.trim() } : {}) }, t('statusChanged', { reference: record.reference, status: t(`status.${status as 'verifying'}`) }));
      }}
      busy={busy}
    >
      <FormProblem error={error} clientErrors={missing ? { note: t('noteRequired') } : {}} fields={{ note: { label: t('outcomeNote'), id: noteId } }} />
      <SelectField label={t('newStatus')} value={status} onChange={setStatus} options={record.nextStatuses.map((id) => ({ id, label: t(`status.${id}`) }))} />
      <TextField
        id={noteId}
        label={t('outcomeNote')}
        description={t('outcomeNoteHelp')}
        value={note}
        onChange={(value) => {
          setNote(value);
          setMissing(false);
        }}
        multiline
        maxLength={1000}
        dir="auto"
        isRequired={needsNote}
        error={missing ? t('noteRequired') : fieldErrorsOf(error)['note']}
      />
    </ConfirmDialog>
  );
}

function AssignDialog({ record, onClose }: { record: PrivacyRequestDto; onClose: () => void }) {
  const t = useTranslations('privacy');
  const { error, busy, run } = useAction(record, onClose);
  const [assignee, setAssignee] = useState<PickedMember | null>(record.assignedTo ? { membershipId: record.assignedTo.id, displayName: record.assignedTo.name } : null);
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}
      title={t('assignTitle', { reference: record.reference })}
      consequence={t('assignConsequence')}
      confirmLabel={t('assign')}
      onConfirm={() => void run('assign', { assignedTo: assignee?.membershipId ?? null }, t('assigned', { reference: record.reference }))}
      busy={busy}
    >
      {error ? <FormProblem error={error} fields={{}} /> : null}
      <PeoplePicker label={t('assignTo')} value={assignee} onChange={setAssignee} permission="privacy.manage" error={fieldErrorsOf(error)['assignedTo']} />
    </ConfirmDialog>
  );
}

function ExtendDialog({ record, onClose }: { record: PrivacyRequestDto; onClose: () => void }) {
  const t = useTranslations('privacy');
  const { error, busy, run } = useAction(record, onClose);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const ids = { date: useId(), reason: useId() };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}
      title={t('extendTitle', { reference: record.reference })}
      consequence={t('extendConsequence')}
      confirmLabel={t('extend')}
      onConfirm={() => void run('extend', { extendedDueOn: date, reason: reason.trim() }, t('extended', { reference: record.reference }))}
      busy={busy}
    >
      <FormProblem error={error} fields={{ extendedDueOn: { label: t('newDueOn'), id: ids.date }, reason: { label: t('reason'), id: ids.reason } }} />
      <TextField id={ids.date} label={t('newDueOn')} type="date" value={date} onChange={setDate} isRequired min={record.dueOn} error={fieldErrorsOf(error)['extendedDueOn']} />
      <TextField id={ids.reason} label={t('reason')} value={reason} onChange={setReason} multiline maxLength={500} isRequired dir="auto" error={fieldErrorsOf(error)['reason']} />
    </ConfirmDialog>
  );
}

function EvidenceDialog({ record, onClose }: { record: PrivacyRequestDto; onClose: () => void }) {
  const t = useTranslations('privacy');
  const { error, busy, run } = useAction(record, onClose);
  const [kind, setKind] = useState<(typeof KINDS)[number]>('correspondence');
  const [summary, setSummary] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const ids = { summary: useId(), date: useId() };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}
      title={t('evidenceTitle', { reference: record.reference })}
      consequence={t('evidenceConsequence')}
      confirmLabel={t('addEvidence')}
      onConfirm={() => void run('evidence', { kind, summary: summary.trim(), receivedOn: date }, t('evidenceAdded', { reference: record.reference }), false)}
      busy={busy}
    >
      <FormProblem error={error} fields={{ summary: { label: t('evidenceSummary'), id: ids.summary }, receivedOn: { label: t('evidenceDate'), id: ids.date } }} />
      <SelectField label={t('kind')} value={kind} onChange={(value) => setKind(value as (typeof KINDS)[number])} options={KINDS.map((id) => ({ id, label: t(`evidenceKind.${id}`) }))} />
      <TextField id={ids.summary} label={t('evidenceSummary')} description={t('evidenceNoNumbers')} value={summary} onChange={setSummary} multiline maxLength={1000} isRequired dir="auto" error={fieldErrorsOf(error)['summary']} />
      <TextField id={ids.date} label={t('evidenceDate')} type="date" value={date} onChange={setDate} isRequired max={new Date().toISOString().slice(0, 10)} error={fieldErrorsOf(error)['receivedOn']} />
    </ConfirmDialog>
  );
}
