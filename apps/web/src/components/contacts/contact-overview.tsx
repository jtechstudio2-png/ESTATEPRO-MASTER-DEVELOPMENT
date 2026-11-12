'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { CompleteDialog } from '@/components/activity/follow-ups-list';
import { FollowUpDialog } from '@/components/activity/follow-up-dialog';
import { ActivityTimeline } from '@/components/activity/timeline';
import { useAnnounce } from '@/components/announcer';
import { CONTACT_ROLES, type ContactRole, Ltr, OverdueMark } from '@/components/crm/labels';
import { useContact } from '@/components/crm/use-crm';
import { ContactPrivacyRequests } from '@/components/privacy/contact-requests';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { Checkbox, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Facts, formClass, Panel, RecordLayout } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { When } from '@/components/ui/when';
import type { AddMethodBody, ContactDto, MethodDto, TaskDto, TaskPageDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useCountries, usePicklist } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';

import styles from './contacts.module.css';

const METHOD_TYPES = ['mobile', 'phone', 'whatsapp', 'email', 'fax', 'website', 'other'] as const;

/**
 * C-2 Overview: everything needed to act on one person — how to reach them,
 * the next follow-up, roles, details and the latest activity. No protected
 * value appears here; the Identity tab shows them masked (C-5).
 */
export function ContactOverview({ id }: { id: string }) {
  const t = useTranslations('contacts');
  const crm = useTranslations('crm');
  const common = useTranslations('common');
  const { can, readOnly } = useSession();
  const contact = useContact(id);
  const format = useFormat();
  const sources = usePicklist('lead_source');
  const countries = useCountries();
  const nextTask = useQuery({
    queryKey: ['record', 'contact-next-task', id],
    queryFn: () => bff<TaskPageDto>(`tasks?filter[entityType]=contact&filter[entityId]=${id}&filter[status]=open&sort=dueAt&limit=1`),
  });
  const [dialog, setDialog] = useState<{ kind: 'addMethod' } | { kind: 'addRole' } | { kind: 'endRole'; relationshipId: string; role: ContactRole } | { kind: 'done' | 'reschedule'; task: TaskDto } | null>(null);
  if (!contact.data) return null;
  const record = contact.data;
  const writable = !readOnly && record.archivedAt === null && !record.isAnonymised && record.mergedIntoContactId === null && record.access.canEdit;
  const country = (code: string | null) => (code ? (countries.data?.data.find((item) => item.code === code)?.name ?? code) : null);
  const activeRoles = record.relationships.filter((relationship) => relationship.status === 'active');
  const task = nextTask.data?.data[0] ?? null;

  return (
    <RecordLayout
      asideLabel={t('asideLabel')}
      main={
        <>
          <MethodsPanel contact={record} writable={writable} onAdd={() => setDialog({ kind: 'addMethod' })} />
          <Panel title={t('details')}>
            <Facts
              items={[
                record.contactType === 'organisation' && record.organisationName ? { label: t('organisationName'), value: <bdi dir="auto">{record.organisationName}</bdi> } : null,
                record.givenName || record.familyName ? { label: t('fullName'), value: <bdi dir="auto">{[record.title, record.givenName, record.otherNames, record.familyName].filter(Boolean).join(' ')}</bdi> } : null,
                { label: t('preferredChannel'), value: record.preferredChannel ? t(`channel.${record.preferredChannel}`) : common('notSet') },
                { label: t('language'), value: record.preferredLocaleCode ? <bdi dir="ltr">{record.preferredLocaleCode}</bdi> : common('notSet') },
                record.nationalityCountryCode ? { label: t('nationality'), value: country(record.nationalityCountryCode) } : null,
                record.residenceCountryCode ? { label: t('residence'), value: country(record.residenceCountryCode) } : null,
                { label: t('source'), value: record.sourceCode ? (sources.data?.data.find((value) => value.code === record.sourceCode)?.label ?? record.sourceCode) : common('notSet') },
                record.notes ? { label: common('notes'), value: <span className={styles.body} dir="auto">{record.notes}</span> } : null,
                can('kyc.view') ? { label: t('sensitiveDetails'), value: <NextLink href={`/contacts/${id}/identity`}>{t('sensitiveLink')}</NextLink> } : null,
                { label: common('created'), value: <When iso={record.createdAt} /> },
              ]}
            />
          </Panel>
          <ActivityTimeline about={{ entityType: 'contact', entityId: id, label: record.displayName }} canLog={writable} limit={5} seeAllHref={`/contacts/${id}/activity`} />
        </>
      }
      aside={
        <>
          <ContactPrivacyRequests contactId={id} canLog={record.mergedIntoContactId === null} />
          <Panel title={t('nextFollowUp')}>
            {nextTask.isPending ? (
              <Skeleton />
            ) : nextTask.isError ? (
              <ErrorNotice error={nextTask.error} />
            ) : task ? (
              <div className={styles.duplicate}>
                <p>
                  {task.dueAt ? <When iso={task.dueAt} /> : null} · <bdi dir="auto">{task.title}</bdi>
                </p>
                <p className={styles.meta}>
                  <bdi>{task.assignedTo.name}</bdi> <OverdueMark overdue={task.overdue} />
                </p>
                {task.canEdit && !readOnly ? (
                  <div className={styles.actions}>
                    <Button size="small" onPress={() => setDialog({ kind: 'done', task })}>
                      {t('done')}
                    </Button>
                    <Button size="small" onPress={() => setDialog({ kind: 'reschedule', task })}>
                      {t('reschedule')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <p>{t('noFollowUp')}</p>
            )}
          </Panel>
          <Panel
            title={t('roles')}
            actions={
              writable && activeRoles.length < CONTACT_ROLES.length ? (
                <Button size="small" onPress={() => setDialog({ kind: 'addRole' })}>
                  {t('addRole')}
                </Button>
              ) : undefined
            }
          >
            {activeRoles.length === 0 ? (
              <p>{crm('noRoles')}</p>
            ) : (
              <ul className={styles.list}>
                {activeRoles.map((relationship) => (
                  <li key={relationship.id}>
                    <span>{t('roleSince', { role: crm(`role.${relationship.relationshipType}`), date: format.date(relationship.startedOn) })}</span>
                    {writable ? (
                      <Button size="small" variant="quiet" onPress={() => setDialog({ kind: 'endRole', relationshipId: relationship.id, role: relationship.relationshipType })} aria-label={t('endRoleNamed', { role: crm(`role.${relationship.relationshipType}`) })}>
                        {t('endRole')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {dialog?.kind === 'addMethod' ? <AddMethodDialog contact={record} onClose={() => setDialog(null)} /> : null}
          {dialog?.kind === 'addRole' ? <AddRoleDialog contact={record} onClose={() => setDialog(null)} /> : null}
          {dialog?.kind === 'endRole' ? <EndRoleDialog contact={record} relationshipId={dialog.relationshipId} role={dialog.role} onClose={() => setDialog(null)} /> : null}
          {dialog?.kind === 'done' ? <CompleteDialog task={dialog.task} onClose={() => setDialog(null)} /> : null}
          {dialog?.kind === 'reschedule' ? <FollowUpDialog task={dialog.task} onClose={() => setDialog(null)} /> : null}
        </>
      }
    />
  );
}

/** Contact methods (C-2): primary, verified and opted-out states in text, never colour alone. */
function MethodsPanel({ contact, writable, onAdd }: { contact: ContactDto; writable: boolean; onAdd: () => void }) {
  const t = useTranslations('contacts');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<MethodDto | null>(null);
  const update = async (method: MethodDto, body: Record<string, unknown>, message: string) => {
    setError(null);
    try {
      await bff(`contacts/${contact.id}/methods/${method.id}`, { method: 'PATCH', body });
      announce(message);
      await refresh();
    } catch (caught) {
      setError(caught);
    }
  };
  const menu = (method: MethodDto): MenuAction[] => {
    if (!writable) return [];
    const actions: MenuAction[] = [];
    if (!method.isPrimary) actions.push({ id: 'primary', label: t('makePrimary'), onAction: () => void update(method, { isPrimary: true }, t('madePrimary', { value: method.value })) });
    actions.push(
      method.optedOutAt === null
        ? { id: 'optout', label: t('markOptedOut'), onAction: () => void update(method, { optedOut: true }, t('optedOutDone', { value: method.value })) }
        : { id: 'optin', label: t('clearOptOut'), onAction: () => void update(method, { optedOut: false }, t('optInDone', { value: method.value })) },
    );
    if (method.verifiedAt === null) actions.push({ id: 'verify', label: t('markVerified'), onAction: () => void update(method, { verified: true }, t('verifiedDone', { value: method.value })) });
    if (!method.isPrimary) actions.push({ id: 'remove', label: t('removeMethod'), onAction: () => setRemoving(method), danger: true });
    return actions;
  };
  return (
    <Panel
      title={t('methods')}
      actions={
        writable ? (
          <Button size="small" onPress={onAdd}>
            {t('addMethod')}
          </Button>
        ) : undefined
      }
    >
      {error ? <ErrorNotice error={error} /> : null}
      {contact.methods.length === 0 ? (
        <EmptyState title={t('noMethods')} headingLevel={3} />
      ) : (
        <ul className={styles.list}>
          {contact.methods.map((method) => (
            <li key={method.id}>
              <span className={styles.itemMain}>
                <span>
                  <strong>{t(`methodType.${method.methodType}`)}</strong> <Ltr>{method.value}</Ltr>
                  {method.label ? <span className={styles.meta}> · <bdi dir="auto">{method.label}</bdi></span> : null}
                </span>
                <span className={styles.actions}>
                  {method.isPrimary ? (
                    <StatusLabel tone="info" icon="★">
                      {t('primary')}
                    </StatusLabel>
                  ) : null}
                  {method.verifiedAt ? <StatusLabel tone="success" icon="✓">{t('verified')}</StatusLabel> : null}
                  {method.optedOutAt ? (
                    <StatusLabel tone="warning" icon="⊘">
                      {t('optedOut')}
                    </StatusLabel>
                  ) : null}
                </span>
              </span>
              <ActionsMenu label={t('methodActions', { value: method.value })} actions={menu(method)} />
            </li>
          ))}
        </ul>
      )}
      {removing ? (
        <RemoveMethodDialog
          contact={contact}
          method={removing}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </Panel>
  );
}

function RemoveMethodDialog({ contact, method, onClose }: { contact: ContactDto; method: MethodDto; onClose: () => void }) {
  const t = useTranslations('contacts');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await bff(`contacts/${contact.id}/methods/${method.id}`, { method: 'DELETE' });
      announce(t('methodRemoved', { value: method.value }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('removeMethodTitle')}
      consequence={t('removeMethodConsequence', { value: method.value })}
      confirmLabel={t('removeMethod')}
      onConfirm={() => void submit()}
      busy={busy}
      danger
    >
      {error ? <FormProblem error={error} fields={{}} /> : null}
    </ConfirmDialog>
  );
}

function AddMethodDialog({ contact, onClose }: { contact: ContactDto; onClose: () => void }) {
  const t = useTranslations('contacts');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [methodType, setMethodType] = useState<AddMethodBody['methodType']>('mobile');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [primary, setPrimary] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const valueId = useId();
  const submit = async () => {
    if (value.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bff(`contacts/${contact.id}/methods`, { method: 'POST', body: { methodType, value: value.trim(), ...(label.trim() ? { label: label.trim() } : {}), isPrimary: primary } });
      announce(t('methodAdded', { value: value.trim() }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('addMethodTitle')}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {t('addMethod')}
          </Button>
        </>
      }
    >
      <div className={formClass}>
        <FormProblem error={error} fields={{ value: { label: t('methodValue'), id: valueId } }} />
        <SelectField label={t('methodTypeLabel')} value={methodType} onChange={(next) => setMethodType(next as AddMethodBody['methodType'])} options={METHOD_TYPES.map((id) => ({ id, label: t(`methodType.${id}`) }))} />
        <TextField
          id={valueId}
          label={t('methodValue')}
          description={methodType === 'email' || methodType === 'website' ? undefined : t('phoneHelp')}
          type={methodType === 'email' ? 'email' : methodType === 'website' ? 'url' : 'tel'}
          inputMode={methodType === 'email' ? 'email' : methodType === 'website' ? 'url' : 'tel'}
          value={value}
          onChange={(next) => {
            setValue(next);
            setMissing(false);
          }}
          isRequired
          dir="ltr"
          maxLength={320}
          error={missing ? t('methodValueRequired') : fieldErrorsOf(error)['value']}
        />
        <TextField label={t('methodLabel')} value={label} onChange={setLabel} maxLength={60} dir="auto" />
        <Checkbox isSelected={primary} onChange={setPrimary}>
          {t('makePrimary')}
        </Checkbox>
      </div>
    </Dialog>
  );
}

function AddRoleDialog({ contact, onClose }: { contact: ContactDto; onClose: () => void }) {
  const t = useTranslations('contacts');
  const crm = useTranslations('crm');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const active = new Set(contact.relationships.filter((relationship) => relationship.status === 'active').map((relationship) => relationship.relationshipType));
  const available = CONTACT_ROLES.filter((role) => !active.has(role));
  const [role, setRole] = useState<ContactRole>(available[0] ?? 'other');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await bff(`contacts/${contact.id}/relationships`, { method: 'POST', body: { relationshipType: role } });
      announce(t('roleAdded', { role: crm(`role.${role}`) }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('addRoleTitle')} consequence={t('addRoleConsequence')} confirmLabel={t('addRole')} onConfirm={() => void submit()} busy={busy}>
      {error ? <FormProblem error={error} fields={{}} /> : null}
      <SelectField label={t('role')} value={role} onChange={(next) => setRole(next as ContactRole)} options={available.map((id) => ({ id, label: crm(`role.${id}`) }))} />
    </ConfirmDialog>
  );
}

function EndRoleDialog({ contact, relationshipId, role, onClose }: { contact: ContactDto; relationshipId: string; role: ContactRole; onClose: () => void }) {
  const t = useTranslations('contacts');
  const crm = useTranslations('crm');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await bff(`contacts/${contact.id}/relationships/${relationshipId}/end`, { method: 'POST', body: {} });
      announce(t('roleEnded', { role: crm(`role.${role}`) }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('endRoleTitle', { role: crm(`role.${role}`) })}
      consequence={t('endRoleConsequence', { name: contact.displayName, role: crm(`role.${role}`) })}
      confirmLabel={t('endRole')}
      onConfirm={() => void submit()}
      busy={busy}
    >
      {error ? <FormProblem error={error} fields={{}} /> : null}
    </ConfirmDialog>
  );
}
