'use client';

import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';

import { Ltr } from '@/components/crm/labels';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import type { DuplicateCandidateDto, DuplicateCheckResultDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { ApiError } from '@/lib/problem';

import styles from './contacts.module.css';

interface CheckInput {
  primaryEmail?: string;
  primaryPhone?: string;
  officeId?: string | null;
  excludeContactId?: string;
}

/**
 * Duplicate check as the user leaves the phone or email field (C-3). It is
 * advisory: the user may continue, and that choice is sent with the save
 * (`confirmNotDuplicate`) and recorded. A failed check never blocks typing.
 */
export function useDuplicateCheck() {
  const [candidates, setCandidates] = useState<DuplicateCandidateDto[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [lastKey, setLastKey] = useState('');
  const check = useCallback(
    async (input: CheckInput) => {
      const email = input.primaryEmail?.trim() ?? '';
      const phone = input.primaryPhone?.trim() ?? '';
      const key = `${email}|${phone}`;
      if (key === lastKey) return;
      setLastKey(key);
      if (email === '' && phone === '') {
        setCandidates([]);
        return;
      }
      try {
        const result = await bff<DuplicateCheckResultDto>('contacts/duplicate-check', {
          method: 'POST',
          body: {
            ...(email ? { primaryEmail: email } : {}),
            ...(phone ? { primaryPhone: phone } : {}),
            ...(input.officeId ? { officeId: input.officeId } : {}),
            ...(input.excludeContactId ? { excludeContactId: input.excludeContactId } : {}),
          },
        });
        setCandidates(result.candidates);
        setConfirmed(false);
      } catch {
        // Advisory only: the server checks again on save.
      }
    },
    [lastKey],
  );
  /** A 409 possible-duplicates on save shows the same panel. */
  const fromError = useCallback((error: unknown): boolean => {
    if (error instanceof ApiError && error.code === 'possible-duplicates') {
      setCandidates((error.problem.candidates ?? []) as DuplicateCandidateDto[]);
      setConfirmed(false);
      return true;
    }
    return false;
  }, []);
  return { candidates, confirmed, confirm: () => setConfirmed(true), check, fromError };
}

/**
 * "Possible duplicate" panel (C-3). Candidates outside the member's scope are
 * not named: no cross-scope disclosure, only "ask a manager".
 */
export function DuplicatePanel({ candidates, confirmed, onConfirm }: { candidates: DuplicateCandidateDto[]; confirmed: boolean; onConfirm: () => void }) {
  const t = useTranslations('contacts');
  if (candidates.length === 0) return null;
  const visible = candidates.filter((candidate) => candidate.visible && candidate.id !== null);
  const hidden = candidates.length - visible.length;
  return (
    <section aria-label={t('duplicateTitle')} className={styles.duplicate}>
      <Notice
        tone="warning"
        title={
          <>
            <span aria-hidden="true">⚠ </span>
            {t('duplicateTitle')}
          </>
        }
        action={
          confirmed ? (
            <p>{t('duplicateConfirmed')}</p>
          ) : (
            <Button onPress={onConfirm}>{t('notSamePerson')}</Button>
          )
        }
      >
        <ul className={styles.list}>
          {visible.map((candidate) => (
            <li key={candidate.id}>
              <span>
                <bdi dir="auto">{candidate.displayName}</bdi>
                {candidate.reference ? (
                  <>
                    {' '}
                    (<Ltr>{candidate.reference}</Ltr>)
                  </>
                ) : null}{' '}
                {t('duplicateMatched', { fields: candidate.matchedOn.map((field) => t(`matchedOn.${field}`)).join(', ') })}
                {candidate.ownerName ? ` ${t('duplicateOwner', { name: candidate.ownerName })}` : ''}
                {candidate.archived ? ` ${t('duplicateArchived')}` : ''}
              </span>
              <NextLink href={`/contacts/${candidate.id}`} target="_blank">
                {t('openExisting')}
              </NextLink>
            </li>
          ))}
          {hidden > 0 ? <li>{t('duplicateHidden', { count: hidden })}</li> : null}
        </ul>
      </Notice>
    </section>
  );
}
