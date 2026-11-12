'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useId, useState } from 'react';
import { Button as AriaButton, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';

import { FollowUpDialog } from '@/components/activity/follow-up-dialog';
import { LogActivityDialog, type LinkedRecord } from '@/components/activity/log-activity';
import { useAnnounce } from '@/components/announcer';
import { ContactName, Ltr, RoleList } from '@/components/crm/labels';
import { telHref, useContact } from '@/components/crm/use-crm';
import { useSession } from '@/components/session';
import { Button, buttonClass, LinkButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import fieldStyles from '@/components/ui/field.module.css';
import { TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Page, PageHeader, RecordTabs } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { SearchBox } from '@/components/ui/list-controls';
import type { ContactDto, ContactPageDto, MethodDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useDocumentTitle } from '@/lib/hooks/document-title';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import styles from './contacts.module.css';

type Channel = 'whatsapp' | 'sms' | 'email';

/** Where a message action opens the member's own app (Phase 5 records; it never sends, CRM-10). */
function messageHref(channel: Channel, value: string): string {
  const digits = value.replace(/[^\d]/g, '');
  if (channel === 'whatsapp') return `https://wa.me/${digits}`;
  if (channel === 'sms') return `sms:${value.replace(/[^\d+]/g, '')}`;
  return `mailto:${value}`;
}

/** Message channels from the contact's methods, each with whether the person opted out (C-2, C-6). */
export function messageChannels(contact: ContactDto): Array<{ channel: Channel; method: MethodDto; blocked: boolean }> {
  const result: Array<{ channel: Channel; method: MethodDto; blocked: boolean }> = [];
  for (const method of contact.methods) {
    const blocked = method.optedOutAt !== null;
    if (method.methodType === 'whatsapp') result.push({ channel: 'whatsapp', method, blocked });
    if (method.methodType === 'mobile') result.push({ channel: 'sms', method, blocked });
    if (method.methodType === 'email') result.push({ channel: 'email', method, blocked });
  }
  return result;
}

/** Marketing withdrawn on any channel, from the current consents (C-2 warning line). */
export function marketingWithdrawn(contact: ContactDto): ContactDto['consents'] {
  return contact.consents.filter((consent) => consent.purpose === 'marketing' && consent.status === 'withdrawn');
}

/**
 * C-2 contact record frame: header with Call, Message, Follow-up and Edit,
 * warnings (archived, merged, anonymised, consent), and tabs that appear only
 * with their own permission. The URL holds the tab.
 */
export function ContactFrame({ id, children }: { id: string; children: ReactNode }) {
  const t = useTranslations('contacts');
  const crm = useTranslations('crm');
  const common = useTranslations('common');
  const errors = useTranslations('errors');
  const pathname = usePathname();
  const router = useRouter();
  const announce = useAnnounce();
  const format = useFormat();
  const { can, readOnly } = useSession();
  const contact = useContact(id);
  const [dialog, setDialog] = useState<'archive' | 'restore' | 'merge' | 'followUp' | null>(null);
  const [logging, setLogging] = useState<{ type: 'call' | Channel } | null>(null);
  const [afterCall, setAfterCall] = useState(false);
  useDocumentTitle(contact.data?.displayName);

  if (contact.isPending) {
    return (
      <Page>
        <div aria-busy="true">
          <Skeleton width="40%" />
          <Skeleton width="60%" />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (contact.isError) {
    return (
      <Page>
        {contact.error instanceof ApiError && contact.error.status === 404 ? (
          <EmptyState title={t('notFound')} action={<LinkButton href="/contacts">{t('backToList')}</LinkButton>}>
            {errors('notFoundDetail')}
          </EmptyState>
        ) : (
          <ErrorNotice error={contact.error} onRetry={() => void contact.refetch()} />
        )}
      </Page>
    );
  }

  const record = contact.data;
  const base = `/contacts/${id}`;
  const roles = record.relationships.filter((relationship) => relationship.status === 'active').map((relationship) => relationship.relationshipType);
  const tabs = [
    { href: base, label: t('tabs.overview'), current: pathname === base },
    { href: `${base}/activity`, label: t('tabs.activity'), current: pathname.startsWith(`${base}/activity`) },
    ...(can('lead.view') ? [{ href: `${base}/leads`, label: t('tabs.leads'), current: pathname.startsWith(`${base}/leads`) }] : []),
    { href: `${base}/requirements`, label: t('tabs.requirements'), current: pathname.startsWith(`${base}/requirements`) },
    ...(can('property.view') ? [{ href: `${base}/properties`, label: t('tabs.properties'), current: pathname.startsWith(`${base}/properties`) }] : []),
    ...(can('kyc.view') ? [{ href: `${base}/identity`, label: t('tabs.identity'), current: pathname.startsWith(`${base}/identity`) }] : []),
    { href: `${base}/consent`, label: t('tabs.consent'), current: pathname.startsWith(`${base}/consent`) },
  ];

  const writable = !readOnly && record.archivedAt === null && !record.isAnonymised && record.mergedIntoContactId === null;
  const canWrite = writable && record.access.canEdit;
  const channels = messageChannels(record);
  const withdrawn = marketingWithdrawn(record);
  const menu: MenuAction[] = [];
  if (record.reference) {
    menu.push({
      id: 'copy',
      label: common('copyReference'),
      onAction: () => void navigator.clipboard?.writeText(record.reference!).then(() => announce(common('copied', { value: record.reference! }))),
    });
  }
  if (record.access.canMerge && writable) menu.push({ id: 'merge', label: t('merge'), onAction: () => setDialog('merge') });
  if (record.access.canArchive && !readOnly && record.mergedIntoContactId === null) {
    menu.push(
      record.archivedAt === null
        ? { id: 'archive', label: t('archive'), onAction: () => setDialog('archive'), danger: true }
        : { id: 'restore', label: t('restore'), onAction: () => setDialog('restore') },
    );
  }
  const links: LinkedRecord[] = [{ entityType: 'contact', entityId: record.id, label: record.displayName }];

  return (
    <Page>
      <PageHeader
        back={{ href: '/contacts', label: t('backToList') }}
        title={<ContactName name={record.displayName} local={record.displayNameLocal} />}
        subtitle={
          <>
            {record.reference ? <Ltr>{record.reference}</Ltr> : null}
            <span aria-hidden="true">·</span>
            <span>{crm(`contactType.${record.contactType}`)}</span>
            <span aria-hidden="true">·</span>
            <RoleList roles={roles} />
            {record.owner ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{t('ownerLine', { name: record.owner.name })}</span>
              </>
            ) : null}
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
            {record.primaryPhone && !record.isAnonymised ? (
              <a
                className={buttonClass('secondary')}
                href={telHref(record.primaryPhone)}
                onClick={() => {
                  if (canWrite) setAfterCall(true);
                }}
                aria-label={t('callNamed', { name: record.displayName })}
              >
                <span aria-hidden="true">☎ </span>
                {t('call')}
              </a>
            ) : null}
            {channels.length > 0 && !record.isAnonymised ? (
              <MenuTrigger>
                <AriaButton className={buttonClass('secondary')} aria-label={t('messageNamed', { name: record.displayName })}>
                  {t('message')}
                </AriaButton>
                <Popover className={fieldStyles.popover} placement="bottom end">
                  <Menu
                    aria-label={t('messageNamed', { name: record.displayName })}
                    disabledKeys={channels.filter((entry) => entry.blocked).map((entry) => entry.method.id)}
                    onAction={(key) => {
                      const entry = channels.find((item) => item.method.id === key);
                      if (!entry) return;
                      window.open(messageHref(entry.channel, entry.method.value), '_blank', 'noopener');
                      if (canWrite) setLogging({ type: entry.channel });
                    }}
                  >
                    {channels.map((entry) => (
                      <MenuItem key={entry.method.id} id={entry.method.id} className={fieldStyles.option} textValue={`${t(`channel.${entry.channel}`)} ${entry.method.value}`}>
                        {t(`channel.${entry.channel}`)} · <Ltr>{entry.method.value}</Ltr>
                        {entry.blocked ? (
                          <>
                            {' '}
                            <span aria-hidden="true">⊘</span> {t('optedOut')}
                          </>
                        ) : null}
                      </MenuItem>
                    ))}
                  </Menu>
                </Popover>
              </MenuTrigger>
            ) : null}
            {writable ? <Button onPress={() => setDialog('followUp')}>{t('addFollowUp')}</Button> : null}
            {canWrite ? (
              <LinkButton href={`${base}/edit`} variant="primary">
                {common('edit')}
              </LinkButton>
            ) : null}
            <ActionsMenu label={common('moreActions', { name: record.displayName })} actions={menu} />
          </>
        }
      />
      {record.mergedIntoContactId ? (
        <Notice tone="info" title={t('mergedBanner')} action={<LinkButton href={`/contacts/${record.mergedIntoContactId}`}>{t('openSurviving')}</LinkButton>} />
      ) : null}
      {record.isAnonymised ? <Notice tone="warning" title={t('anonymisedBanner')} /> : null}
      {record.archivedAt !== null ? <Notice tone="warning" title={t('archivedBanner', { date: format.date(record.archivedAt), reason: record.archivedReason ?? '' })} /> : null}
      {withdrawn.length > 0 ? (
        <div className={styles.warningLine}>
          <Notice tone="warning">
            <span aria-hidden="true">⚠ </span>
            {withdrawn
              .map((consent) => t('marketingWithdrawn', { date: format.date(consent.capturedAt), channel: consent.channel ? crm(`consentChannel.${consent.channel}`) : crm('consentChannel.any') }))
              .join(' · ')}
          </Notice>
        </div>
      ) : null}
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
                  setLogging({ type: 'call' });
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
      <RecordTabs label={t('tabs.label')} tabs={tabs} />
      {children}
      {logging ? (
        <LogActivityDialog
          links={links}
          initialType={logging.type}
          initialDirection="outbound"
          onClose={() => setLogging(null)}
          onScheduleFollowUp={() => setDialog('followUp')}
        />
      ) : null}
      {dialog === 'followUp' ? <FollowUpDialog about={{ entityType: 'contact', entityId: record.id, label: record.displayName }} onClose={() => setDialog(null)} /> : null}
      {dialog === 'archive' || dialog === 'restore' ? <ArchiveContactDialog contact={record} mode={dialog} onClose={() => setDialog(null)} /> : null}
      {dialog === 'merge' ? <ChooseMergeDialog contact={record} onClose={() => setDialog(null)} onChoose={(other) => router.push(`${base}/merge?with=${other}`)} /> : null}
    </Page>
  );
}

/** Archive (reason required) or restore, with If-Match (C-2). */
function ArchiveContactDialog({ contact, mode, onClose }: { contact: ContactDto; mode: 'archive' | 'restore'; onClose: () => void }) {
  const t = useTranslations('contacts');
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
      await bff(`contacts/${contact.id}/${mode}`, { method: 'POST', version: contact.version, body: mode === 'archive' ? { reason: reason.trim() } : {} });
      announce(mode === 'archive' ? t('archived', { name: contact.displayName }) : t('restored', { name: contact.displayName }));
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
      title={mode === 'archive' ? t('archiveTitle', { name: contact.displayName }) : t('restoreTitle', { name: contact.displayName })}
      consequence={mode === 'archive' ? t('archiveConsequence') : t('restoreConsequence')}
      confirmLabel={mode === 'archive' ? t('archiveConfirm') : t('restoreConfirm')}
      onConfirm={() => void submit()}
      busy={busy}
      danger={mode === 'archive'}
    >
      {error instanceof ApiError && error.status === 412 ? (
        <Notice tone="warning" title={common('conflictTitle')}>
          {common('conflictDetail')}
        </Notice>
      ) : (
        <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} />
      )}
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

/** Picks the other contact to merge (C-4): search within the member's own scope. */
function ChooseMergeDialog({ contact, onClose, onChoose }: { contact: ContactDto; onClose: () => void; onChoose: (id: string) => void }) {
  const t = useTranslations('contacts');
  const [term, setTerm] = useState('');
  const results = useQuery({
    queryKey: ['list', 'merge-search', term],
    queryFn: () => bff<ContactPageDto>(`contacts${query({ q: term, limit: 10 })}`),
    enabled: term.length >= 2,
  });
  const candidates = (results.data?.data ?? []).filter((row) => row.id !== contact.id);
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('mergeChooseTitle', { name: contact.displayName })}>
      <p>{t('mergeChooseHelp')}</p>
      <SearchBox label={t('searchLabel')} value={term} onChange={setTerm} />
      {results.isError ? <ErrorNotice error={results.error} /> : null}
      {term.length >= 2 && results.isSuccess && candidates.length === 0 ? <p>{t('mergeNoMatches')}</p> : null}
      <ul className={styles.list}>
        {candidates.map((row) => (
          <li key={row.id}>
            <span className={styles.itemMain}>
              <ContactName name={row.displayName} local={row.displayNameLocal} />
              <span className={styles.meta}>
                {row.reference ? <Ltr>{row.reference}</Ltr> : null} {row.primaryPhoneMasked ? <Ltr>{row.primaryPhoneMasked}</Ltr> : null}
              </span>
            </span>
            <Button size="small" onPress={() => onChoose(row.id)} aria-label={t('mergeWithNamed', { name: row.displayName })}>
              {t('mergeWith')}
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
