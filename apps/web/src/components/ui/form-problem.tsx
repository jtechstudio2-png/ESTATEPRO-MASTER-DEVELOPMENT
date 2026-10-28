'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef } from 'react';

import { ApiError, errorsByField } from '@/lib/problem';

import { ErrorNotice } from './feedback';
import styles from './feedback.module.css';

export interface FieldRef {
  label: string;
  id: string;
}

/** Field errors of a failed submission (422 validation-failed), keyed by API field path. */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  return error instanceof ApiError && error.status === 422 ? errorsByField(error.fieldErrors) : {};
}

/**
 * Shows why a submission failed (UI checklist §7): a validation summary with
 * links to the fields (focus moves to it), or the mapped problem otherwise.
 * `clientErrors` are checks made before sending, shown the same way.
 */
export function FormProblem({ error, clientErrors = {}, fields }: { error: unknown; clientErrors?: Record<string, string>; fields: Record<string, FieldRef> }) {
  const t = useTranslations('form');
  const summary = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const fieldErrors = { ...fieldErrorsOf(error), ...clientErrors };
  const entries = Object.entries(fieldErrors);
  const hasFieldErrors = entries.length > 0;
  useEffect(() => {
    if (hasFieldErrors) summary.current?.focus();
  }, [hasFieldErrors, error, clientErrors]);
  if (hasFieldErrors) {
    return (
      <div ref={summary} className={`${styles.notice} ${styles.danger}`} role="alert" tabIndex={-1} aria-labelledby={titleId}>
        <p className={styles.noticeTitle} id={titleId}>
          {t('errorSummary')}
        </p>
        <ul>
          {entries.map(([field, message]) => {
            const ref = fields[field];
            return (
              <li key={field}>
                {ref ? (
                  <a
                    href={`#${ref.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(ref.id)?.focus();
                    }}
                  >
                    {ref.label}: {message}
                  </a>
                ) : (
                  message
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  if (error === null || error === undefined) return null;
  return <ErrorNotice error={error} />;
}
