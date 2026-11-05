'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useContact } from '@/components/crm/use-crm';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { FieldRow, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem } from '@/components/ui/form-problem';
import { formClass, Panel } from '@/components/ui/layout';
import type { ConsentDto, ConsentHistoryDto, ConsentInput } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';

import styles from './contacts.module.css';

const PURPOSES = ['marketing', 'property_alerts', 'data_processing', 'third_party_sharing', 'portal_terms'] as const;
const CHANNELS = ['any', 'email', 'sms', 'whatsapp', 'phone', 'post'] as const;
const BASES = ['consent', 'contract', 'legal_obligation', 'legitimate_interest'] as const;
const VIA = ['web_form', 'verbal', 'paper', 'email', 'portal'] as const;

/** The current state: the latest row per purpose and channel (consents are append-only, C-6). */
export function currentConsents(history: ConsentDto[]): ConsentDto[] {
  const latest = new Map<string, ConsentDto>();
  for (const row of history) {
    const key = `${row.purpose}|${row.channel ?? 'any'}`;
    const seen = latest.get(key);
    if (!seen || seen.capturedAt < row.capturedAt) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.purpose.localeCompare(b.purpose) || (a.channel ?? '').localeCompare(b.channel ?? ''));
}

/**
 * C-6 consent and communication preferences: proves what the person agreed
 * to, when and how. Rows are never edited; a change or correction is a new
 * row, and a withdrawal takes effect at once in Message actions.
 */
export function ConsentTab({ id }: { id: string }) {
  const t = useTranslations('consent');
  const crm = useTranslations('crm');
  const format = useFormat();
  const { readOnly } = useSession();
  const contact = useContact(id);
  const history = useQuery({ queryKey: ['record', 'consents', id], queryFn: () => bff<ConsentHistoryDto>(`contacts/${id}/consents`) });
  const [showAll, setShowAll] = useState(false);
  const [recording, setRecording] = useState(false);
  const writable = contact.data !== undefined && !readOnly && contact.data.access.canEdit && contact.data.archivedAt === null && !contact.data.isAnonymised;
  const rows = history.data ? (showAll ? [...history.data.data].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)) : currentConsents(history.data.data)) : [];

  return (
    <Panel
      title={t('title')}
      actions={
        writable ? (
          <Button variant="primary" onPress={() => setRecording(true)}>
            {t('record')}
          </Button>
        ) : undefined
      }
    >
      {history.isPending ? (
        <Skeleton />
      ) : history.isError ? (
        <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('empty')} headingLevel={3}>
          {t('emptyDetail')}
        </EmptyState>
      ) : (
        <div className={styles.tableRegion} role="region" aria-label={showAll ? t('historyCaption') : t('currentCaption')} tabIndex={0}>
          <table className={styles.choices}>
            <caption className="ep-visually-hidden">{showAll ? t('historyCaption') : t('currentCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('purpose')}</th>
                <th scope="col">{t('channel')}</th>
                <th scope="col">{t('status')}</th>
                <th scope="col">{t('basis')}</th>
                <th scope="col">{t('captured')}</th>
                <th scope="col">{t('via')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{t(`purposeValue.${row.purpose}`)}</th>
                  <td>{crm(`consentChannel.${row.channel ?? 'any'}`)}</td>
                  <td>
                    {row.status === 'granted' ? (
                      <StatusLabel tone="success" icon="✓">
                        {t('granted')}
                      </StatusLabel>
                    ) : (
                      <StatusLabel tone="warning" icon="⊘">
                        {t('withdrawn')}
                      </StatusLabel>
                    )}
                  </td>
                  <td>{row.lawfulBasis ? t(`basisValue.${row.lawfulBasis}`) : '—'}</td>
                  <td>
                    <time dateTime={row.capturedAt} className="ep-num">
                      {format.dateTime(row.capturedAt)}
                    </time>
                  </td>
                  <td>
                    {t(`viaValue.${row.capturedVia}`)}
                    {row.evidence ? (
                      <span className={styles.meta}>
                        {' '}
                        · <bdi dir="auto">{row.evidence}</bdi>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button onPress={() => setShowAll(!showAll)} aria-pressed={showAll}>
        {showAll ? t('showCurrent') : t('showHistory')}
      </Button>
      <p className={styles.meta}>{t('appendOnly')}</p>
      {recording ? <RecordConsentDialog contactId={id} onClose={() => setRecording(false)} /> : null}
    </Panel>
  );
}

function RecordConsentDialog({ contactId, onClose }: { contactId: string; onClose: () => void }) {
  const t = useTranslations('consent');
  const crm = useTranslations('crm');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [purpose, setPurpose] = useState<ConsentInput['purpose']>('marketing');
  const [channel, setChannel] = useState<ConsentInput['channel']>('email');
  const [status, setStatus] = useState<ConsentInput['status']>('granted');
  const [basis, setBasis] = useState<NonNullable<ConsentInput['lawfulBasis']>>('consent');
  const [via, setVia] = useState<ConsentInput['capturedVia']>('verbal');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: ConsentInput = {
        purpose,
        channel,
        status,
        capturedVia: via,
        ...(status === 'granted' ? { lawfulBasis: basis } : {}),
        ...(evidence.trim() ? { evidence: evidence.trim() } : {}),
      };
      await bff(`contacts/${contactId}/consents`, { method: 'POST', body });
      announce(status === 'granted' ? t('recordedGranted', { purpose: t(`purposeValue.${purpose}`) }) : t('recordedWithdrawn', { purpose: t(`purposeValue.${purpose}`) }));
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
      title={t('recordTitle')}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {t('record')}
          </Button>
        </>
      }
    >
      <div className={formClass}>
        <FormProblem error={error} fields={{}} />
        <FieldRow>
          <SelectField label={t('purpose')} value={purpose} onChange={(value) => setPurpose(value as ConsentInput['purpose'])} options={PURPOSES.map((id) => ({ id, label: t(`purposeValue.${id}`) }))} />
          <SelectField label={t('channel')} value={channel} onChange={(value) => setChannel(value as ConsentInput['channel'])} options={CHANNELS.map((id) => ({ id, label: crm(`consentChannel.${id}`) }))} />
        </FieldRow>
        <FieldRow>
          <SelectField
            label={t('status')}
            value={status}
            onChange={(value) => setStatus(value as ConsentInput['status'])}
            options={[
              { id: 'granted', label: t('granted') },
              { id: 'withdrawn', label: t('withdrawn') },
            ]}
          />
          {status === 'granted' ? (
            <SelectField label={t('basis')} value={basis} onChange={(value) => setBasis(value as NonNullable<ConsentInput['lawfulBasis']>)} options={BASES.map((id) => ({ id, label: t(`basisValue.${id}`) }))} />
          ) : null}
        </FieldRow>
        <SelectField label={t('via')} value={via} onChange={(value) => setVia(value as ConsentInput['capturedVia'])} options={VIA.map((id) => ({ id, label: t(`viaValue.${id}`) }))} />
        <TextField label={t('evidence')} description={t('evidenceHelp')} value={evidence} onChange={setEvidence} multiline maxLength={500} dir="auto" />
        {status === 'withdrawn' ? <Notice tone="warning">{t('withdrawEffect')}</Notice> : null}
      </div>
    </Dialog>
  );
}
