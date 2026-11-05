'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { FollowUpDialog } from '@/components/activity/follow-up-dialog';
import { LogActivityDialog } from '@/components/activity/log-activity';
import { ActivityTimeline } from '@/components/activity/timeline';
import { useAnnounce } from '@/components/announcer';
import contactStyles from '@/components/contacts/contacts.module.css';
import { LeadStatusLabel, Ltr, ResponseLabel } from '@/components/crm/labels';
import { useContact, useLead } from '@/components/crm/use-crm';
import { telHref } from '@/components/crm/use-crm';
import { useSession } from '@/components/session';
import { Button, buttonClass, LinkButton } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Facts, Page, PageHeader, Panel, RecordLayout } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { When } from '@/components/ui/when';
import type { LeadDto, TaskPageDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useDocumentTitle } from '@/lib/hooks/document-title';
import { useFormat } from '@/lib/hooks/format';
import { usePicklist } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

type Dialog = 'status' | 'assign' | 'archive' | 'restore' | 'followUp' | 'log' | null;

/**
 * L-2 lead record: the enquiry, the contact, the score with its breakdown
 * (never an opaque score, D7), next action, activity, status history and
 * assignments. Status changes offer only the allowed next statuses (L-4).
 */
export function LeadRecord({ id }: { id: string }) {
  const t = useTranslations('leads');
  const crm = useTranslations('crm');
  const common = useTranslations('common');
  const errors = useTranslations('errors');
  const announce = useAnnounce();
  const format = useFormat();
  const { readOnly } = useSession();
  const lead = useLead(id);
  const sources = usePicklist('lead_source');
  const lostReasons = usePicklist('lost_reason');
  const contact = useContact(lead.data?.contact.id ?? '', lead.data !== undefined);
  const nextTask = useQuery({
    queryKey: ['record', 'lead-next-task', id],
    queryFn: () => bff<TaskPageDto>(`tasks?filter[entityType]=lead&filter[entityId]=${id}&filter[status]=open&sort=dueAt&limit=1`),
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [afterCall, setAfterCall] = useState(false);
  useDocumentTitle(lead.data ? `${lead.data.reference} · ${lead.data.contact.name}` : null);

  if (lead.isPending) {
    return (
      <Page>
        <div aria-busy="true">
          <Skeleton width="40%" />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (lead.isError) {
    return (
      <Page>
        {lead.error instanceof ApiError && lead.error.status === 404 ? (
          <EmptyState title={t('notFound')} action={<LinkButton href="/leads">{t('backToList')}</LinkButton>}>
            {errors('notFoundDetail')}
          </EmptyState>
        ) : (
          <ErrorNotice error={lead.error} onRetry={() => void lead.refetch()} />
        )}
      </Page>
    );
  }

  const record = lead.data;
  const writable = !readOnly && record.archivedAt === null && record.access.canEdit;
  const phone = contact.data?.primaryPhone ?? null;
  const task = nextTask.data?.data[0] ?? null;
  const menu: MenuAction[] = [
    {
      id: 'copy',
      label: common('copyReference'),
      onAction: () => void navigator.clipboard?.writeText(record.reference).then(() => announce(common('copied', { value: record.reference }))),
    },
  ];
  if (record.access.canEdit && !readOnly) {
    menu.push(record.archivedAt === null ? { id: 'archive', label: t('archive'), onAction: () => setDialog('archive'), danger: true } : { id: 'restore', label: t('restore'), onAction: () => setDialog('restore') });
  }
  const sourceLabel = sources.data?.data.find((value) => value.code === record.sourceCode)?.label ?? record.sourceCode;
  const contactLink = { entityType: 'contact' as const, entityId: record.contact.id, label: record.contact.name };

  return (
    <Page>
      <PageHeader
        back={{ href: '/leads', label: t('backToList') }}
        title={
          <>
            <bdi dir="auto">{record.contact.name}</bdi> · <Ltr>{record.reference}</Ltr>
          </>
        }
        subtitle={
          <>
            <span>{crm(`leadType.${record.leadType}`)}</span>
            <span aria-hidden="true">·</span>
            <LeadStatusLabel status={record.status} />
            <ResponseLabel response={record.response} />
            <span aria-hidden="true">·</span>
            <span>{record.assignedTo ? t('assignedTo', { name: record.assignedTo.name }) : t('unassigned')}</span>
            {record.office ? (
              <>
                <span aria-hidden="true">·</span>
                <bdi>{record.office.name}</bdi>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {phone ? (
              <a
                className={buttonClass('secondary')}
                href={telHref(phone)}
                onClick={() => {
                  if (writable) setAfterCall(true);
                }}
                aria-label={t('callNamed', { name: record.contact.name })}
              >
                <span aria-hidden="true">☎ </span>
                {t('call')}
              </a>
            ) : null}
            {writable ? <Button onPress={() => setDialog('log')}>{t('logActivity')}</Button> : null}
            {writable && record.access.nextStatuses.length > 0 ? (
              <Button variant="primary" onPress={() => setDialog('status')}>
                {t('changeStatus')}
              </Button>
            ) : null}
            {record.access.canAssign && !readOnly && record.archivedAt === null ? <Button onPress={() => setDialog('assign')}>{t('assign')}</Button> : null}
            <ActionsMenu label={common('moreActions', { name: record.reference })} actions={menu} />
          </>
        }
      />
      {record.archivedAt ? <Notice tone="warning" title={t('archivedBanner', { date: format.date(record.archivedAt), reason: record.archivedReason ?? '' })} /> : null}
      {afterCall ? (
        <Notice
          tone="info"
          title={t('afterCallTitle')}
          action={
            <>
              <Button
                variant="primary"
                onPress={() => {
                  setAfterCall(false);
                  setDialog('log');
                }}
              >
                {t('logCall')}
              </Button>
              <Button onPress={() => setAfterCall(false)}>{t('dismiss')}</Button>
            </>
          }
        >
          {t('afterCallDetail')}
        </Notice>
      ) : null}
      <RecordLayout
        asideLabel={t('asideLabel')}
        main={
          <>
            <Panel title={t('enquiry')}>
              <Facts
                items={[
                  { label: t('received'), value: <span>{format.dateTime(record.receivedAt)}</span> },
                  { label: t('source'), value: record.sourceDetail ? `${sourceLabel} · ${record.sourceDetail}` : sourceLabel },
                  record.campaign ? { label: t('campaign'), value: <bdi dir="auto">{record.campaign}</bdi> } : null,
                  record.listing ? { label: t('listing'), value: <NextLink href={`/listings/${record.listing.id}`}><Ltr>{record.listing.reference}</Ltr> <bdi dir="auto">{record.listing.title}</bdi></NextLink> } : null,
                  record.firstResponseAt ? { label: t('firstResponse'), value: format.dateTime(record.firstResponseAt) } : record.response ? { label: t('respondBy'), value: format.dateTime(record.response.dueAt) } : null,
                  record.lostReasonCode ? { label: t('lostReason'), value: lostReasons.data?.data.find((value) => value.code === record.lostReasonCode)?.label ?? record.lostReasonCode } : null,
                ]}
              />
              {record.message ? (
                <p className={contactStyles.body} dir="auto">
                  {record.message}
                </p>
              ) : (
                <p>{t('noMessage')}</p>
              )}
            </Panel>
            <ActivityTimeline about={{ entityType: 'lead', entityId: id, label: record.reference }} extraLinks={[]} canLog={writable} />
            <Panel title={t('statusHistory')}>
              <ol className={contactStyles.list}>
                {[...record.statusHistory].reverse().map((change, index) => (
                  <li key={index}>
                    <span className={contactStyles.itemMain}>
                      <span>
                        {change.fromStatus ? t('statusChange', { from: crm(`leadStatus.${change.fromStatus}`), to: crm(`leadStatus.${change.toStatus}`) }) : t('statusStart', { to: crm(`leadStatus.${change.toStatus}`) })}
                      </span>
                      <span className={contactStyles.meta}>
                        <When iso={change.changedAt} /> {change.changedBy ? `· ${change.changedBy.name}` : ''}
                      </span>
                      {change.note ? (
                        <span className={contactStyles.body} dir="auto">
                          {change.note}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            </Panel>
            <Panel title={t('assignments')}>
              {record.assignments.length === 0 ? (
                <p>{t('neverAssigned')}</p>
              ) : (
                <ol className={contactStyles.list}>
                  {[...record.assignments].reverse().map((assignment, index) => (
                    <li key={index}>
                      <span className={contactStyles.itemMain}>
                        <span>{t('assignmentLine', { to: assignment.assignedTo.name, by: assignment.assignedBy?.name ?? crm('system') })}</span>
                        <span className={contactStyles.meta}>
                          <When iso={assignment.assignedAt} />
                        </span>
                        {assignment.note ? (
                          <span className={contactStyles.body} dir="auto">
                            {assignment.note}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </>
        }
        aside={
          <>
            <Panel title={t('contactPanel')}>
              <p>
                <NextLink href={`/contacts/${record.contact.id}`}>
                  <bdi dir="auto">{record.contact.name}</bdi>
                </NextLink>
              </p>
              {record.contact.primaryPhoneMasked ? <Ltr>{record.contact.primaryPhoneMasked}</Ltr> : null}
              {contact.data?.preferredChannel ? <p className={contactStyles.meta}>{t('prefers', { channel: t(`channel.${contact.data.preferredChannel}`) })}</p> : null}
            </Panel>
            {record.score !== null ? (
              <Panel title={t('score', { score: record.score })}>
                <ul className={contactStyles.list}>
                  {record.scoreBreakdown.map((rule) => (
                    <li key={rule.rule}>
                      <span>{rule.rule}</span>
                      <span className="ep-num">{t('points', { points: rule.points })}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
            <Panel title={t('nextActionTitle')}>
              {task ? (
                <p>
                  {task.dueAt ? <When iso={task.dueAt} /> : null} · <bdi dir="auto">{task.title}</bdi> · <bdi>{task.assignedTo.name}</bdi>
                </p>
              ) : (
                <p>
                  <span aria-hidden="true">⚠ </span>
                  {t('noNextAction')}
                </p>
              )}
              {writable ? (
                <Button size="small" onPress={() => setDialog('followUp')}>
                  {t('addFollowUp')}
                </Button>
              ) : null}
            </Panel>
          </>
        }
      />
      {dialog === 'status' ? <StatusDialog lead={record} onClose={() => setDialog(null)} /> : null}
      {dialog === 'assign' ? <AssignDialog lead={record} onClose={() => setDialog(null)} /> : null}
      {dialog === 'archive' || dialog === 'restore' ? <ArchiveLeadDialog lead={record} mode={dialog} onClose={() => setDialog(null)} /> : null}
      {dialog === 'followUp' ? <FollowUpDialog about={{ entityType: 'lead', entityId: id, label: record.reference }} onClose={() => setDialog(null)} /> : null}
      {dialog === 'log' ? (
        <LogActivityDialog
          links={[{ entityType: 'lead', entityId: id, label: record.reference }, contactLink]}
          initialType="call"
          onClose={() => setDialog(null)}
          onScheduleFollowUp={() => setDialog('followUp')}
        />
      ) : null}
    </Page>
  );
}

/** L-4 change status: only allowed next statuses; lost needs a reason, unqualified a note (C3-D1). */
function StatusDialog({ lead, onClose }: { lead: LeadDto; onClose: () => void }) {
  const t = useTranslations('leads');
  const crm = useTranslations('crm');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const lostReasons = usePicklist('lost_reason');
  const [status, setStatus] = useState<string>(lead.access.nextStatuses[0] ?? 'contacted');
  const [lostReason, setLostReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ids = { note: useId(), lost: useId() };
  const reopening = lead.status === 'unqualified' || lead.status === 'lost';
  const submit = async () => {
    const errors: Record<string, string> = {};
    if (status === 'lost' && lostReason === '') errors['lostReasonCode'] = t('lostReasonRequired');
    if ((status === 'unqualified' || reopening) && note.trim() === '') errors['note'] = t('noteRequired');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await bff(`leads/${lead.id}/status`, {
        method: 'POST',
        version: lead.version,
        body: { status, ...(status === 'lost' ? { lostReasonCode: lostReason } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      });
      announce(t('statusChanged', { status: crm(`leadStatus.${status as 'contacted'}`) }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('statusTitle', { reference: lead.reference })}
      consequence={reopening ? t('reopenConsequence') : t('statusConsequence')}
      confirmLabel={t('changeStatus')}
      onConfirm={() => void submit()}
      busy={busy}
    >
      <FormProblem error={error} clientErrors={clientErrors} fields={{ note: { label: t('note'), id: ids.note }, lostReasonCode: { label: t('lostReason'), id: ids.lost } }} />
      <SelectField label={t('newStatus')} value={status} onChange={setStatus} options={lead.access.nextStatuses.map((id) => ({ id, label: crm(`leadStatus.${id}`) }))} />
      {status === 'lost' ? (
        <SelectField
          id={ids.lost}
          label={t('lostReason')}
          value={lostReason || '__none__'}
          onChange={(value) => setLostReason(value === '__none__' ? '' : value)}
          isRequired
          options={[{ id: '__none__', label: t('chooseReason') }, ...(lostReasons.data?.data ?? []).map((value) => ({ id: value.code, label: value.label }))]}
          error={clientErrors['lostReasonCode'] ?? fieldErrorsOf(error)['lostReasonCode']}
        />
      ) : null}
      <TextField
        id={ids.note}
        label={t('note')}
        value={note}
        onChange={setNote}
        multiline
        maxLength={1000}
        dir="auto"
        isRequired={status === 'unqualified' || reopening}
        error={clientErrors['note'] ?? fieldErrorsOf(error)['note']}
      />
    </ConfirmDialog>
  );
}

/** L-4 assign (lead.assign): to a member who works the lead's office (D6). */
function AssignDialog({ lead, onClose }: { lead: LeadDto; onClose: () => void }) {
  const t = useTranslations('leads');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [assignee, setAssignee] = useState<PickedMember | null>(null);
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (assignee === null) {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bff(`leads/${lead.id}/assign`, { method: 'POST', version: lead.version, body: { assignedTo: assignee.membershipId, ...(note.trim() ? { note: note.trim() } : {}) } });
      announce(t('assignedDone', { reference: lead.reference, name: assignee.displayName }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('assignTitle', { reference: lead.reference })} consequence={t('assignConsequence')} confirmLabel={t('assign')} onConfirm={() => void submit()} busy={busy}>
      {error ? <FormProblem error={error} fields={{}} /> : null}
      <PeoplePicker
        label={t('assignTo')}
        value={assignee}
        onChange={(member) => {
          setAssignee(member);
          setMissing(false);
        }}
        permission="lead.view"
        {...(lead.office ? { officeId: lead.office.id } : {})}
        isRequired
        error={missing ? t('assigneeRequired') : fieldErrorsOf(error)['assignedTo']}
      />
      <TextField label={t('note')} value={note} onChange={setNote} multiline maxLength={1000} dir="auto" />
    </ConfirmDialog>
  );
}

function ArchiveLeadDialog({ lead, mode, onClose }: { lead: LeadDto; mode: 'archive' | 'restore'; onClose: () => void }) {
  const t = useTranslations('leads');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const submit = async () => {
    if (mode === 'archive' && reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bff(`leads/${lead.id}/${mode}`, { method: 'POST', version: lead.version, body: mode === 'archive' ? { reason: reason.trim() } : {} });
      announce(mode === 'archive' ? t('archived', { reference: lead.reference }) : t('restored', { reference: lead.reference }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={mode === 'archive' ? t('archiveTitle', { reference: lead.reference }) : t('restoreTitle', { reference: lead.reference })}
      consequence={mode === 'archive' ? t('archiveConsequence') : t('restoreConsequence')}
      confirmLabel={mode === 'archive' ? t('archive') : t('restore')}
      onConfirm={() => void submit()}
      busy={busy}
      danger={mode === 'archive'}
    >
      <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} />
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
