'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { IdentityStatusLabel } from '@/components/crm/labels';
import { useContact } from '@/components/crm/use-crm';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { FieldRow, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass, Panel, Stack } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { When } from '@/components/ui/when';
import type { ContactDto, IdentityDocumentDto, KycCheckDto, RevealedValueDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useCountries, usePicklist } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import styles from './contacts.module.css';
import { RevealDialog, RevealedValue } from './reveal';

const CHECK_TYPES = ['identity', 'address', 'source_of_funds', 'sanctions_pep', 'company_ownership'] as const;
const RISKS = ['low', 'medium', 'high'] as const;
const NONE = '__none__';

type ProtectedField = 'dateOfBirth' | 'taxNumber' | 'organisationRegNumber';

/**
 * Identity tab: C-5 sensitive details (masked; reveal with reason and
 * step-up), identity documents (numbers encrypted, last four shown) and KYC
 * checks with sign-off (CA-9). Visible with `kyc.view`. Mobile shows no
 * reveal: "Open on a computer to reveal" (wireframes §8).
 */
export function IdentityTab({ id }: { id: string }) {
  const t = useTranslations('identity');
  const contact = useContact(id);
  if (!contact.data) return null;
  return (
    <Stack>
      <SensitivePanel contact={contact.data} />
      <DocumentsPanel contact={contact.data} />
      <ChecksPanel contact={contact.data} />
      <Notice tone="info">{t('dataNote')}</Notice>
    </Stack>
  );
}

function SensitivePanel({ contact }: { contact: ContactDto }) {
  const t = useTranslations('identity');
  const [revealing, setRevealing] = useState<ProtectedField | null>(null);
  const [revealed, setRevealed] = useState<Partial<Record<ProtectedField, RevealedValueDto>>>({});
  const fields: ProtectedField[] = contact.contactType === 'person' ? ['dateOfBirth', 'taxNumber'] : ['taxNumber', 'organisationRegNumber'];
  const values = contact.protected;
  const canReveal = contact.access.canReveal && !contact.isAnonymised;
  return (
    <Panel title={t('sensitiveTitle')}>
      {values === undefined ? (
        <p>{t('noAccess')}</p>
      ) : (
        <ul className={styles.list}>
          {fields.map((field) => {
            const value = values[field];
            const shown = revealed[field];
            return (
              <li key={field}>
                <span className={styles.itemMain}>
                  <strong>{t(`field.${field}`)}</strong>
                  {shown ? (
                    <RevealedValue value={shown} onHide={() => setRevealed((current) => ({ ...current, [field]: undefined }))} />
                  ) : value.recorded ? (
                    <span className={styles.masked} aria-label={value.last4 ? t('maskedLast4', { last4: value.last4 }) : t('maskedValue')}>
                      {field === 'dateOfBirth' ? '••/••/••••' : `•••• ${value.last4 ?? ''}`}
                    </span>
                  ) : (
                    <span>{t('notRecorded')}</span>
                  )}
                </span>
                {value.recorded && canReveal && !shown ? (
                  <span className={styles.actions}>
                    <span className={styles.desktopOnly}>
                      <Button size="small" onPress={() => setRevealing(field)} aria-label={t('revealNamed', { label: t(`field.${field}`) })}>
                        {t('reveal')}
                      </Button>{' '}
                      <span className={styles.meta}>{t('requiresVerification')}</span>
                    </span>
                    <span className={styles.mobileOnly}>{t('openOnComputer')}</span>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className={styles.meta}>{t('revealRules')}</p>
      {revealing ? (
        <RevealDialog
          label={t(`field.${revealing}`)}
          path={`contacts/${contact.id}/sensitive/${revealing}/reveal`}
          onRevealed={(value) => setRevealed((current) => ({ ...current, [revealing]: value }))}
          onClose={() => setRevealing(null)}
        />
      ) : null}
    </Panel>
  );
}

function DocumentsPanel({ contact }: { contact: ContactDto }) {
  const t = useTranslations('identity');
  const format = useFormat();
  const { can, readOnly } = useSession();
  const types = usePicklist('id_document_type');
  const countries = useCountries();
  const [archived, setArchived] = useState(false);
  const documents = useQuery({
    queryKey: ['record', 'identity-documents', contact.id, archived],
    queryFn: () => bff<IdentityDocumentDto[]>(`contacts/${contact.id}/identity-documents${archived ? '?includeArchived=true' : ''}`),
  });
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit' | 'archive' | 'reveal'; document: IdentityDocumentDto } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, RevealedValueDto | undefined>>({});
  const typeLabel = (code: string) => types.data?.data.find((value) => value.code === code)?.label ?? code;
  const countryName = (code: string) => countries.data?.data.find((country) => country.code === code)?.name ?? code;
  const canManage = can('kyc.manage') && !readOnly && contact.archivedAt === null && !contact.isAnonymised;

  const menu = (document: IdentityDocumentDto): MenuAction[] => {
    const actions: MenuAction[] = [];
    if (document.canEdit && document.archivedAt === null && !readOnly) {
      actions.push({ id: 'edit', label: t('editDocument'), onAction: () => setDialog({ kind: 'edit', document }) });
      actions.push({ id: 'archive', label: t('archiveDocument'), onAction: () => setDialog({ kind: 'archive', document }), danger: true });
    }
    return actions;
  };

  return (
    <Panel
      title={t('documentsTitle')}
      actions={
        <>
          <Button size="small" aria-pressed={archived} onPress={() => setArchived(!archived)}>
            {t('showArchived')}
          </Button>
          {canManage ? (
            <Button size="small" variant="primary" onPress={() => setDialog({ kind: 'add' })}>
              {t('addDocument')}
            </Button>
          ) : null}
        </>
      }
    >
      {documents.isPending ? (
        <Skeleton />
      ) : documents.isError ? (
        <ErrorNotice error={documents.error} onRetry={() => void documents.refetch()} />
      ) : documents.data.length === 0 ? (
        <EmptyState title={t('noDocuments')} headingLevel={3} />
      ) : (
        <ul className={styles.list}>
          {documents.data.map((document) => {
            const shown = revealed[document.id];
            return (
              <li key={document.id}>
                <span className={styles.itemMain}>
                  <strong>
                    {typeLabel(document.documentTypeCode)} · {countryName(document.issuingCountryCode)}
                  </strong>
                  {shown ? (
                    <RevealedValue value={shown} onHide={() => setRevealed((current) => ({ ...current, [document.id]: undefined }))} />
                  ) : document.numberLast4 === null ? (
                    <span className={styles.meta}>{t('numberErased')}</span>
                  ) : (
                    <span className={styles.masked} aria-label={t('maskedLast4', { last4: document.numberLast4 })}>
                      •••• {document.numberLast4}
                    </span>
                  )}
                  <span className={styles.meta}>
                    {document.issuedOn ? t('issuedOn', { date: format.date(document.issuedOn) }) : null}
                    {document.issuedOn && document.expiresOn ? ' · ' : null}
                    {document.expiresOn ? t('expiresOn', { date: format.date(document.expiresOn) }) : null}
                  </span>
                  <span className={styles.actions}>
                    {document.expired ? (
                      <StatusLabel tone="warning" icon="⌛">
                        {t('expired')}
                      </StatusLabel>
                    ) : null}
                    {document.verified ? (
                      <StatusLabel tone="success" icon="✓">
                        {t('verifiedBy', { name: document.verified.by.name, date: format.date(document.verified.at) })}
                      </StatusLabel>
                    ) : null}
                    {document.archivedAt ? <StatusLabel tone="neutral">{t('archivedReason', { reason: document.archivedReason ?? '' })}</StatusLabel> : null}
                  </span>
                </span>
                <span className={styles.actions}>
                  {document.canReveal && !shown && document.archivedAt === null ? (
                    <span className={styles.desktopOnly}>
                      <Button size="small" onPress={() => setDialog({ kind: 'reveal', document })} aria-label={t('revealNamed', { label: typeLabel(document.documentTypeCode) })}>
                        {t('reveal')}
                      </Button>
                    </span>
                  ) : null}
                  <ActionsMenu label={t('documentActions', { type: typeLabel(document.documentTypeCode) })} actions={menu(document)} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {dialog?.kind === 'add' || dialog?.kind === 'edit' ? <DocumentDialog contact={contact} document={dialog.kind === 'edit' ? dialog.document : null} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'archive' ? <ArchiveDocumentDialog contact={contact} document={dialog.document} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'reveal' ? (
        <RevealDialog
          label={typeLabel(dialog.document.documentTypeCode)}
          path={`contacts/${contact.id}/identity-documents/${dialog.document.id}/reveal`}
          onRevealed={(value) => setRevealed((current) => ({ ...current, [dialog.document.id]: value }))}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Panel>
  );
}

/** Add or correct an identity document. The number is typed, encrypted by the API and shown back only as its last four. */
function DocumentDialog({ contact, document, onClose }: { contact: ContactDto; document: IdentityDocumentDto | null; onClose: () => void }) {
  const t = useTranslations('identity');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const types = usePicklist('id_document_type');
  const countries = useCountries();
  const [typeCode, setTypeCode] = useState(document?.documentTypeCode ?? NONE);
  const [country, setCountry] = useState(document?.issuingCountryCode ?? NONE);
  const [number, setNumber] = useState('');
  const [issuedOn, setIssuedOn] = useState(document?.issuedOn ?? '');
  const [expiresOn, setExpiresOn] = useState(document?.expiresOn ?? '');
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ids = { type: useId(), country: useId(), number: useId() };

  const submit = async () => {
    const errors: Record<string, string> = {};
    if (typeCode === NONE) errors['documentTypeCode'] = t('typeRequired');
    if (country === NONE) errors['issuingCountryCode'] = t('countryRequired');
    if (document === null && number.trim() === '') errors['documentNumber'] = t('numberRequired');
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    const body = {
      documentTypeCode: typeCode,
      issuingCountryCode: country,
      ...(number.trim() ? { documentNumber: number.trim() } : {}),
      issuedOn: issuedOn || null,
      expiresOn: expiresOn || null,
      ...(confirmDuplicate ? { confirmNotDuplicate: true } : {}),
    };
    try {
      if (document) {
        await bff(`contacts/${contact.id}/identity-documents/${document.id}`, { method: 'PATCH', version: document.version, body });
        announce(t('documentSaved'));
      } else {
        await bff(`contacts/${contact.id}/identity-documents`, { method: 'POST', body });
        announce(t('documentAdded'));
      }
      setNumber('');
      await refresh();
      onClose();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'possible-duplicates') setDuplicate(true);
      else setError(caught);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (field: string) => clientErrors[field] ?? fieldErrorsOf(error)[field];
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={document ? t('editDocumentTitle') : t('addDocumentTitle')}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {common('save')}
          </Button>
        </>
      }
    >
      <div className={formClass}>
        <FormProblem
          error={error}
          clientErrors={clientErrors}
          fields={{
            documentTypeCode: { label: t('documentType'), id: ids.type },
            issuingCountryCode: { label: t('issuingCountry'), id: ids.country },
            documentNumber: { label: t('documentNumber'), id: ids.number },
          }}
        />
        {duplicate ? (
          <Notice
            tone="warning"
            title={t('duplicateTitle')}
            action={
              confirmDuplicate ? undefined : (
                <Button
                  onPress={() => {
                    setConfirmDuplicate(true);
                    setDuplicate(false);
                  }}
                >
                  {t('duplicateContinue')}
                </Button>
              )
            }
          >
            {t('duplicateDetail')}
          </Notice>
        ) : null}
        <FieldRow>
          <SelectField
            id={ids.type}
            label={t('documentType')}
            value={typeCode}
            onChange={setTypeCode}
            isRequired
            options={[{ id: NONE, label: common('notSet') }, ...(types.data?.data ?? []).map((value) => ({ id: value.code, label: value.label }))]}
            error={fieldError('documentTypeCode')}
          />
          <SelectField
            id={ids.country}
            label={t('issuingCountry')}
            value={country}
            onChange={setCountry}
            isRequired
            options={[{ id: NONE, label: common('notSet') }, ...(countries.data?.data ?? []).map((item) => ({ id: item.code, label: item.name }))]}
            error={fieldError('issuingCountryCode')}
          />
        </FieldRow>
        <TextField
          id={ids.number}
          label={t('documentNumber')}
          description={document?.numberLast4 ? t('numberKeep', { last4: document.numberLast4 }) : t('numberHelp')}
          value={number}
          onChange={setNumber}
          isRequired={document === null}
          autoComplete="off"
          dir="ltr"
          maxLength={60}
          error={fieldError('documentNumber')}
        />
        <FieldRow>
          <TextField label={t('issued')} type="date" value={issuedOn} onChange={setIssuedOn} error={fieldError('issuedOn')} />
          <TextField label={t('expires')} type="date" value={expiresOn} onChange={setExpiresOn} error={fieldError('expiresOn')} />
        </FieldRow>
      </div>
    </Dialog>
  );
}

function ArchiveDocumentDialog({ contact, document, onClose }: { contact: ContactDto; document: IdentityDocumentDto; onClose: () => void }) {
  const t = useTranslations('identity');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const submit = async () => {
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bff(`contacts/${contact.id}/identity-documents/${document.id}/archive`, { method: 'POST', version: document.version, body: { reason: reason.trim() } });
      announce(t('documentArchived'));
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
    <ConfirmDialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={t('archiveDocumentTitle')} consequence={t('archiveDocumentConsequence')} confirmLabel={t('archiveDocument')} onConfirm={() => void submit()} busy={busy} danger>
      <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} />
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
    </ConfirmDialog>
  );
}

/** KYC checks (CA-9): recorded by `kyc.manage`, signed off by `kyc.approve`; a signed-off check never changes. */
function ChecksPanel({ contact }: { contact: ContactDto }) {
  const t = useTranslations('identity');
  const format = useFormat();
  const { can, readOnly } = useSession();
  const checks = useQuery({ queryKey: ['record', 'kyc-checks', contact.id], queryFn: () => bff<KycCheckDto[]>(`contacts/${contact.id}/kyc-checks`) });
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit' | 'approve' | 'reject'; check: KycCheckDto } | null>(null);
  const canManage = can('kyc.manage') && !readOnly && contact.archivedAt === null && !contact.isAnonymised;
  const menu = (check: KycCheckDto): MenuAction[] => {
    if (readOnly) return [];
    const actions: MenuAction[] = [];
    if (check.canEdit) actions.push({ id: 'edit', label: t('editCheck'), onAction: () => setDialog({ kind: 'edit', check }) });
    if (check.canDecide) {
      actions.push({ id: 'approve', label: t('approve'), onAction: () => setDialog({ kind: 'approve', check }) });
      actions.push({ id: 'reject', label: t('reject'), onAction: () => setDialog({ kind: 'reject', check }), danger: true });
    }
    return actions;
  };
  return (
    <Panel
      title={t('checksTitle')}
      actions={
        canManage ? (
          <Button size="small" variant="primary" onPress={() => setDialog({ kind: 'add' })}>
            {t('recordCheck')}
          </Button>
        ) : undefined
      }
    >
      {checks.isPending ? (
        <Skeleton />
      ) : checks.isError ? (
        <ErrorNotice error={checks.error} onRetry={() => void checks.refetch()} />
      ) : checks.data.length === 0 ? (
        <EmptyState title={t('noChecks')} headingLevel={3} />
      ) : (
        <ul className={styles.list}>
          {checks.data.map((check) => (
            <li key={check.id}>
              <span className={styles.itemMain}>
                <span className={styles.actions}>
                  <strong>{t(`checkType.${check.checkType}`)}</strong>
                  <IdentityStatusLabel status={check.status} />
                  {check.riskRating ? <StatusLabel tone={check.riskRating === 'high' ? 'danger' : check.riskRating === 'medium' ? 'warning' : 'neutral'}>{t('risk', { rating: t(`riskValue.${check.riskRating}`) })}</StatusLabel> : null}
                </span>
                <span className={styles.meta}>
                  {check.recordedBy ? t('recordedBy', { name: check.recordedBy.name }) : null} · <When iso={check.createdAt} />
                  {check.reviewedBy && check.reviewedAt ? <> · {t('reviewedBy', { name: check.reviewedBy.name, date: format.date(check.reviewedAt) })}</> : null}
                  {check.expiresOn ? <> · {t('expiresOn', { date: format.date(check.expiresOn) })}</> : null}
                </span>
                {check.identityDocument ? (
                  <span className={styles.meta}>
                    {check.identityDocument.numberLast4 === null ? t('linkedDocumentErased') : t('linkedDocument', { last4: check.identityDocument.numberLast4 })}
                  </span>
                ) : null}
                {check.provider ? (
                  <span className={styles.meta}>
                    {t('provider', { name: check.provider })} {check.providerReference ? <bdi dir="ltr">{check.providerReference}</bdi> : null}
                  </span>
                ) : null}
                {check.decisionReason ? (
                  <span className={styles.body} dir="auto">
                    {t('decisionReason', { reason: check.decisionReason })}
                  </span>
                ) : null}
                {check.notes ? (
                  <span className={styles.body} dir="auto">
                    {check.notes}
                  </span>
                ) : null}
              </span>
              <ActionsMenu label={t('checkActions', { type: t(`checkType.${check.checkType}`) })} actions={menu(check)} />
            </li>
          ))}
        </ul>
      )}
      {dialog?.kind === 'add' || dialog?.kind === 'edit' ? <CheckDialog contact={contact} check={dialog.kind === 'edit' ? dialog.check : null} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'approve' || dialog?.kind === 'reject' ? <DecisionDialog contact={contact} check={dialog.check} decision={dialog.kind} onClose={() => setDialog(null)} /> : null}
    </Panel>
  );
}

function CheckDialog({ contact, check, onClose }: { contact: ContactDto; check: KycCheckDto | null; onClose: () => void }) {
  const t = useTranslations('identity');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const documents = useQuery({ queryKey: ['record', 'identity-documents', contact.id, false], queryFn: () => bff<IdentityDocumentDto[]>(`contacts/${contact.id}/identity-documents`) });
  const [checkType, setCheckType] = useState<string>(check?.checkType ?? 'identity');
  const [status, setStatus] = useState<string>(check?.status === 'in_review' ? 'in_review' : 'pending');
  const [documentId, setDocumentId] = useState(check?.identityDocument?.id ?? NONE);
  const [provider, setProvider] = useState(check?.provider ?? '');
  const [providerReference, setProviderReference] = useState(check?.providerReference ?? '');
  const [risk, setRisk] = useState<string>(check?.riskRating ?? NONE);
  const [notes, setNotes] = useState(check?.notes ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const body = {
      status,
      identityDocumentId: documentId === NONE ? null : documentId,
      provider: provider.trim() || null,
      providerReference: providerReference.trim() || null,
      riskRating: risk === NONE ? null : risk,
      notes: notes.trim() || null,
    };
    try {
      if (check) {
        await bff(`contacts/${contact.id}/kyc-checks/${check.id}`, { method: 'PATCH', version: check.version, body });
        announce(t('checkSaved'));
      } else {
        await bff(`contacts/${contact.id}/kyc-checks`, { method: 'POST', body: { ...body, checkType } });
        announce(t('checkRecorded'));
      }
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
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={check ? t('editCheckTitle') : t('recordCheckTitle')}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {common('save')}
          </Button>
        </>
      }
    >
      <div className={formClass}>
        <FormProblem error={error} fields={{}} />
        {check === null ? <SelectField label={t('checkTypeLabel')} value={checkType} onChange={setCheckType} options={CHECK_TYPES.map((id) => ({ id, label: t(`checkType.${id}`) }))} /> : null}
        <SelectField
          label={t('status')}
          value={status}
          onChange={setStatus}
          options={[
            { id: 'pending', label: t('statusValue.pending') },
            { id: 'in_review', label: t('statusValue.in_review') },
          ]}
        />
        <SelectField
          label={t('document')}
          value={documentId}
          onChange={setDocumentId}
          options={[{ id: NONE, label: common('none') }, ...(documents.data ?? []).map((document) => ({ id: document.id, label: document.numberLast4 === null ? `${document.documentTypeCode} · ${t('numberErased')}` : `${document.documentTypeCode} •••• ${document.numberLast4}` }))]}
        />
        <FieldRow>
          <TextField label={t('providerLabel')} value={provider} onChange={setProvider} maxLength={100} />
          <TextField label={t('providerReference')} value={providerReference} onChange={setProviderReference} maxLength={100} dir="ltr" />
        </FieldRow>
        <SelectField label={t('riskLabel')} value={risk} onChange={setRisk} options={[{ id: NONE, label: common('notSet') }, ...RISKS.map((id) => ({ id, label: t(`riskValue.${id}`) }))]} />
        <TextField label={common('notes')} description={t('notesHelp')} value={notes} onChange={setNotes} multiline maxLength={2000} dir="auto" />
        <p>{t('signOffNote')}</p>
      </div>
    </Dialog>
  );
}

/** Sign-off (kyc.approve): approve with a risk rating, or reject with a reason. Final once saved. */
function DecisionDialog({ contact, check, decision, onClose }: { contact: ContactDto; check: KycCheckDto; decision: 'approve' | 'reject'; onClose: () => void }) {
  const t = useTranslations('identity');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [risk, setRisk] = useState<string>(check.riskRating ?? 'low');
  const [expiresOn, setExpiresOn] = useState(check.expiresOn ?? '');
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const submit = async () => {
    if (decision === 'reject' && reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = decision === 'approve' ? { riskRating: risk, expiresOn: expiresOn || null, reason: reason.trim() || null } : { reason: reason.trim(), riskRating: risk };
      await bff(`contacts/${contact.id}/kyc-checks/${check.id}/${decision}`, { method: 'POST', version: check.version, body });
      announce(decision === 'approve' ? t('approved') : t('rejected'));
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
      title={decision === 'approve' ? t('approveTitle', { type: t(`checkType.${check.checkType}`) }) : t('rejectTitle', { type: t(`checkType.${check.checkType}`) })}
      consequence={t('decisionFinal')}
      confirmLabel={decision === 'approve' ? t('approve') : t('reject')}
      onConfirm={() => void submit()}
      busy={busy}
      danger={decision === 'reject'}
    >
      <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} />
      <SelectField label={t('riskLabel')} value={risk} onChange={setRisk} options={RISKS.map((id) => ({ id, label: t(`riskValue.${id}`) }))} />
      {decision === 'approve' ? <TextField label={t('validUntil')} type="date" value={expiresOn} onChange={setExpiresOn} error={fieldErrorsOf(error)['expiresOn']} /> : null}
      <TextField
        id={reasonId}
        label={decision === 'approve' ? t('approveNote') : common('reason')}
        value={reason}
        onChange={(value) => {
          setReason(value);
          setMissing(false);
        }}
        isRequired={decision === 'reject'}
        multiline
        maxLength={1000}
        dir="auto"
        error={missing ? common('reasonRequired') : fieldErrorsOf(error)['reason']}
      />
    </ConfirmDialog>
  );
}
