'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ErrorNotice, Notice } from '@/components/ui/feedback';
import { SelectField, TextField } from '@/components/ui/fields';
import { formClass } from '@/components/ui/layout';
import type { RevealedValueDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { ApiError } from '@/lib/problem';

import styles from './contacts.module.css';

const REASONS = ['identity', 'contract', 'tax', 'subjectRequest', 'other'] as const;
type ReasonKind = (typeof REASONS)[number];
const MIN_REASON = 10;

/**
 * C-5 reveal: one protected value for a stated reason. The API requires
 * `contact.view_sensitive` and a second-factor sign-in within the reveal
 * window; without one it answers "mfa-required" and the dialog offers the
 * step-up sign-in, which returns here. The value is never cached (no-store),
 * never put in a URL, and leaves the page when the timer ends or the panel
 * closes.
 */
export function RevealDialog({ label, path, onRevealed, onClose }: { label: string; path: string; onRevealed: (value: RevealedValueDto) => void; onClose: () => void }) {
  const t = useTranslations('identity');
  const common = useTranslations('common');
  const [kind, setKind] = useState<ReasonKind>('identity');
  const [detail, setDetail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const detailId = useId();

  const submit = async () => {
    const reason = `${t(`reason.${kind}`)}: ${detail.trim()}`;
    if (detail.trim().length < MIN_REASON) {
      setProblem(t('reasonTooShort', { min: MIN_REASON }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const value = await bff<RevealedValueDto>(path, { method: 'POST', body: { reason } });
      onRevealed(value);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const needsStepUp = error instanceof ApiError && error.code === 'mfa-required';
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('revealTitle', { label })}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose} isDisabled={busy}>
            {common('cancel')}
          </Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy}>
            {t('reveal')}
          </Button>
        </>
      }
    >
      <div className={formClass}>
        {needsStepUp ? (
          <Notice tone="warning" title={t('stepUpTitle')}>
            {t('stepUpDetail')}
          </Notice>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        <p>{t('revealAudit')}</p>
        <SelectField label={t('reasonKind')} value={kind} onChange={(value) => setKind(value as ReasonKind)} options={REASONS.map((id) => ({ id, label: t(`reason.${id}`) }))} />
        <TextField
          id={detailId}
          label={t('reasonDetail')}
          description={t('reasonDetailHelp')}
          value={detail}
          onChange={(value) => {
            setDetail(value);
            setProblem(null);
          }}
          isRequired
          multiline
          maxLength={400}
          dir="auto"
          error={problem ?? undefined}
        />
      </div>
    </Dialog>
  );
}

/**
 * A revealed value with its countdown. It hides itself when the time is up
 * (announced politely) and is removed from the page when this unmounts.
 */
export function RevealedValue({ value, onHide }: { value: RevealedValueDto; onHide: () => void }) {
  const t = useTranslations('identity');
  const announce = useAnnounce();
  const [left, setLeft] = useState(value.hideAfterSeconds);
  useEffect(() => {
    const timer = setInterval(() => setLeft((seconds) => seconds - 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (left <= 0) {
      announce(t('hiddenAgain'));
      onHide();
    }
  }, [left, announce, onHide, t]);
  return (
    <span className={styles.actions}>
      <bdi dir="ltr" className={`${styles.revealed} ep-num`}>
        {value.value}
      </bdi>
      <span className={styles.meta}>{t('hidesIn', { seconds: Math.max(left, 0) })}</span>
      <Button size="small" onPress={onHide}>
        {t('hide')}
      </Button>
    </span>
  );
}
