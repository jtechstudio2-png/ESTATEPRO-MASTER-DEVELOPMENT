'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { ApiError, NetworkError } from '@/lib/problem';

import { Button } from './button';
import styles from './feedback.module.css';

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

/** Status text in its semantic colour with a border; never colour alone (Phase 3 01 §1). */
export function StatusLabel({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: string }) {
  return (
    <span className={`${styles.status} ${styles[tone]}`}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

export function Notice({ tone, title, children, action }: { tone: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`${styles.notice} ${styles[tone]}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title ? <p className={styles.noticeTitle}>{title}</p> : null}
      {children ? <div>{children}</div> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}

/**
 * The one place that turns API problems into words (UI checklist §7). Field
 * errors are shown by forms; this covers everything else.
 */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTranslations('errors');
  let title = t('serverTitle');
  let detail: ReactNode = t('serverDetail');
  let reference: string | null = null;
  if (error instanceof NetworkError) {
    title = t('offlineTitle');
    detail = t('offlineDetail');
  } else if (error instanceof ApiError) {
    reference = error.problem.requestId ?? null;
    switch (error.status) {
      case 401:
        title = t('sessionTitle');
        detail = t('sessionDetail');
        break;
      case 403:
        title = error.code === 'mfa-required' ? t('mfaTitle') : t('forbiddenTitle');
        detail = error.problem.detail ?? t('forbiddenDetail');
        break;
      case 404:
        title = t('notFoundTitle');
        detail = t('notFoundDetail');
        break;
      case 409:
      case 412:
      case 422:
        title = error.problem.title;
        detail = error.problem.detail ?? '';
        break;
      case 429:
        title = t('rateTitle');
        detail = t('rateDetail', { seconds: error.retryAfter ?? 60 });
        break;
      case 503:
        if (error.code === 'search-timeout') {
          title = t('searchTimeoutTitle');
          detail = t('searchTimeoutDetail');
        }
        break;
      default:
        break;
    }
  }
  return (
    <Notice
      tone="danger"
      title={title}
      action={
        onRetry || (error instanceof ApiError && error.code === 'mfa-required') ? (
          <>
            {error instanceof ApiError && error.code === 'mfa-required' ? (
              <a href={`/auth/login?stepUp=1&returnTo=${encodeURIComponent(typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search)}`}>
                {t('mfaAction')}
              </a>
            ) : null}
            {onRetry ? <Button onPress={onRetry}>{t('retry')}</Button> : null}
          </>
        ) : undefined
      }
    >
      <p>{detail}</p>
      {reference ? <p className={styles.reference}>{t('reference', { id: reference })}</p> : null}
    </Notice>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ width = '100%' }: { width?: string }) {
  return <span className={styles.skeleton} style={{ inlineSize: width }} aria-hidden="true" />;
}

/** Thin bar shown while refreshing data already on screen (UI checklist §6). */
export function RefreshBar({ active }: { active: boolean }) {
  return active ? <div className={styles.progress} aria-hidden="true" /> : null;
}
