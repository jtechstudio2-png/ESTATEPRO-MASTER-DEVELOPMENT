'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { ContactName, Ltr, RoleList } from '@/components/crm/labels';
import { Button, LinkButton } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { FormProblem } from '@/components/ui/form-problem';
import { Page, PageHeader, Panel } from '@/components/ui/layout';
import type { ContactDto, MergePreviewDto, MergeResultDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import styles from './contacts.module.css';

type MergeField = MergePreviewDto['choosableFields'][number];
const PROTECTED: MergeField[] = ['taxNumber', 'dateOfBirth', 'organisationRegNumber'];

/** A field's value for the comparison table. Protected values show only whether one is recorded (ADR-007). */
function display(contact: ContactDto, field: MergeField, recorded: string, notRecorded: string): string {
  if (PROTECTED.includes(field)) {
    const value = contact.protected?.[field as 'taxNumber' | 'dateOfBirth' | 'organisationRegNumber'];
    if (value === undefined) return '—';
    return value.recorded ? `${recorded}${value.last4 ? ` (…${value.last4})` : ''}` : notRecorded;
  }
  if (field === 'officeId') return contact.office?.name ?? '';
  if (field === 'ownerMembershipId') return contact.owner?.name ?? '';
  const value = (contact as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/**
 * C-4 duplicate review and merge. Nothing merges by itself: the user picks
 * the record to keep and, field by field, which value survives. History,
 * leads, follow-ups and consents move to the kept record; a withdrawal always
 * wins over a grant. Blockers from the API (open erasure request, legal hold,
 * financial records) stop the merge and are shown as stated.
 */
export function MergePage({ id, otherId }: { id: string; otherId: string | null }) {
  const t = useTranslations('merge');
  const common = useTranslations('common');
  const router = useRouter();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [keepId, setKeepId] = useState(id);
  const mergeId = keepId === id ? otherId : id;
  const preview = useQuery({
    queryKey: ['record', 'merge-preview', keepId, mergeId],
    queryFn: () => bff<MergePreviewDto>(`contacts/${keepId}/merge-preview${query({ mergeContactId: mergeId })}`),
    enabled: otherId !== null && mergeId !== null,
  });
  const [choices, setChoices] = useState<Partial<Record<MergeField, 'keep' | 'merge'>>>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (otherId === null) {
    return (
      <Page>
        <EmptyState title={t('noOther')} action={<LinkButton href={`/contacts/${id}`}>{common('back')}</LinkButton>} />
      </Page>
    );
  }
  if (preview.isPending) {
    return (
      <Page>
        <div aria-busy="true">
          <Skeleton />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (preview.isError) {
    return (
      <Page>
        <PageHeader title={t('title')} back={{ href: `/contacts/${id}`, label: common('back') }} />
        <ErrorNotice error={preview.error} onRetry={() => void preview.refetch()} />
      </Page>
    );
  }

  const { keep, merge, blockers, choosableFields } = preview.data;
  const recorded = t('recorded');
  const notRecorded = t('notRecorded');
  const differing = choosableFields.filter((field) => display(keep.contact, field, recorded, notRecorded) !== display(merge.contact, field, recorded, notRecorded));
  const keepRoles = keep.contact.relationships.filter((relationship) => relationship.status === 'active').map((relationship) => relationship.relationshipType);
  const mergeRoles = merge.contact.relationships.filter((relationship) => relationship.status === 'active').map((relationship) => relationship.relationshipType);
  // Reference counts arrive as "table.column"; several columns of one table are shown as one line.
  const byTable = (references: object) => {
    const totals: Record<string, number> = {};
    for (const [key, value] of Object.entries(references as Record<string, number>)) {
      const table = key.split('.')[0] ?? key;
      totals[table] = (totals[table] ?? 0) + Number(value);
    }
    return totals;
  };
  const keepCounts = byTable(keep.references);
  const mergeCounts = byTable(merge.references);
  const referenceKeys = [...new Set([...Object.keys(keepCounts), ...Object.keys(mergeCounts)])].sort();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await bff<MergeResultDto>(`contacts/${keep.contact.id}/merge`, {
        method: 'POST',
        version: keep.contact.version,
        body: { mergeContactId: merge.contact.id, mergeVersion: merge.contact.version, fields: choices },
      });
      announce(t('merged', { name: result.contact.displayName }));
      await refresh();
      router.push(`/contacts/${result.contact.id}`);
    } catch (caught) {
      setError(caught);
      setConfirming(false);
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader title={t('title')} back={{ href: `/contacts/${id}`, label: keep.contact.displayName }} />
      {error ? (
        error instanceof ApiError && error.status === 412 ? (
          <Notice tone="warning" title={common('conflictTitle')}>
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem error={error} fields={{}} />
        )
      ) : null}
      {blockers.length > 0 ? (
        <Notice tone="danger" title={t('blocked')}>
          <ul>
            {preview.data.blockerDetails.map((blocker) => (
              <li key={blocker.code}>
                {t(`blocker.${blocker.code}`, { records: blocker.records.map((table) => (t.has(`reference.${table}`) ? t(`reference.${table}` as 'reference.leads') : table.replace(/_/g, ' '))).join(', ') })}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <Panel title={t('whichToKeep')}>
        <p>
          {t.rich('keepLine', {
            keep: () => (
              <strong>
                <ContactName name={keep.contact.displayName} local={keep.contact.displayNameLocal} /> {keep.contact.reference ? <Ltr>{keep.contact.reference}</Ltr> : null}
              </strong>
            ),
            merge: () => (
              <strong>
                <ContactName name={merge.contact.displayName} local={merge.contact.displayNameLocal} /> {merge.contact.reference ? <Ltr>{merge.contact.reference}</Ltr> : null}
              </strong>
            ),
          })}
        </p>
        <Button
          onPress={() => {
            setKeepId(merge.contact.id);
            setChoices({});
          }}
        >
          {t('swap')}
        </Button>
      </Panel>
      <Panel title={t('fields')}>
        {differing.length === 0 ? (
          <p>{t('noDifferences')}</p>
        ) : (
          <div className={styles.tableRegion} role="region" aria-label={t('fields')} tabIndex={0}>
            <table className={styles.choices}>
              <caption className="ep-visually-hidden">{t('fieldsCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('field')}</th>
                  <th scope="col">{t('keepValue')}</th>
                  <th scope="col">{t('otherValue')}</th>
                  <th scope="col">{t('use')}</th>
                </tr>
              </thead>
              <tbody>
                {differing.map((field) => {
                  const choice = choices[field] ?? 'keep';
                  const name = `merge-${field}`;
                  return (
                    <tr key={field}>
                      <th scope="row">{t(`fieldName.${field}`)}</th>
                      <td>
                        <bdi dir="auto">{display(keep.contact, field, recorded, notRecorded) || '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{display(merge.contact, field, recorded, notRecorded) || '—'}</bdi>
                      </td>
                      <td>
                        <fieldset className={styles.actions}>
                          <legend className="ep-visually-hidden">{t('useFor', { field: t(`fieldName.${field}`) })}</legend>
                          <label>
                            <input type="radio" name={name} checked={choice === 'keep'} onChange={() => setChoices({ ...choices, [field]: 'keep' })} /> {t('useKeep')}
                          </label>
                          <label>
                            <input type="radio" name={name} checked={choice === 'merge'} onChange={() => setChoices({ ...choices, [field]: 'merge' })} /> {t('useOther')}
                          </label>
                        </fieldset>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p>
          {t('rolesLine')} <RoleList roles={[...new Set([...keepRoles, ...mergeRoles])]} />
        </p>
      </Panel>
      <Panel title={t('moves')}>
        {referenceKeys.length === 0 ? (
          <p>{t('nothingMoves')}</p>
        ) : (
          <ul className={styles.list}>
            {referenceKeys.map((key) => (
              <li key={key}>
                <span>{t.has(`reference.${key}`) ? t(`reference.${key}` as 'reference.leads') : key.replace(/_/g, ' ')}</span>
                <span className="ep-num">{t('referenceCounts', { keep: keepCounts[key] ?? 0, other: mergeCounts[key] ?? 0 })}</span>
              </li>
            ))}
          </ul>
        )}
        <Notice tone="warning">{t('consentRule')}</Notice>
      </Panel>
      <div>
        <Button variant="danger" onPress={() => setConfirming(true)} isDisabled={blockers.length > 0}>
          {t('mergeButton')}
        </Button>{' '}
        <LinkButton href={`/contacts/${id}`}>{common('cancel')}</LinkButton>
      </div>
      {confirming ? (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => (open ? undefined : setConfirming(false))}
          title={t('confirmTitle')}
          consequence={t('confirmConsequence', { merge: merge.contact.displayName, keep: keep.contact.displayName })}
          confirmLabel={t('mergeButton')}
          onConfirm={() => void submit()}
          busy={busy}
          danger
          confirmWord={t('confirmWord')}
        />
      ) : null}
    </Page>
  );
}
