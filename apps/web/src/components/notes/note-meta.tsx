'use client';

import { useTranslations } from 'next-intl';

import { When } from '@/components/ui/when';
import type { NoteDto } from '@/lib/api-schema';

import styles from './notes.module.css';

const AUDIENCE_ICON: Record<NoteDto['visibility'], string> = { internal: '🔒', landlord: '✉', tenant: '👤' };

/** Audience as text plus icon, never colour alone (N-1). Portal audiences are described as future ones until issue #12. */
export function AudienceBadge({ note, unitLabel }: { note: Pick<NoteDto, 'visibility'>; unitLabel?: string | null }) {
  const t = useTranslations('notes');
  const label = note.visibility === 'tenant' && unitLabel ? t('visibilityUnit', { unit: unitLabel }) : t(`visibility.${note.visibility}`);
  return (
    <span className={`${styles.audience} ${styles[note.visibility]}`} title={note.visibility === 'internal' ? undefined : t(`futureAudience.${note.visibility}`)}>
      <span aria-hidden="true">{AUDIENCE_ICON[note.visibility]}</span> {label}
      {note.visibility === 'internal' ? null : <span className="ep-visually-hidden"> ({t(`futureAudience.${note.visibility}`)})</span>}
    </span>
  );
}

/** "Access · Internal · Ama B. · 3 Mar · edited" */
export function NoteMeta({ note, pinned = false, unitLabel }: { note: NoteDto; pinned?: boolean; unitLabel?: string | null }) {
  const t = useTranslations('notes');
  return (
    <p className={styles.meta}>
      {pinned ? <span aria-hidden="true">📌 </span> : null}
      <span className={styles.category}>{t(`category.${note.category}`)}</span>
      <span aria-hidden="true"> · </span>
      <AudienceBadge note={note} unitLabel={unitLabel} />
      {note.author ? (
        <>
          <span aria-hidden="true"> · </span>
          <bdi>{note.author.displayName}</bdi>
        </>
      ) : null}
      <span aria-hidden="true"> · </span>
      <When iso={note.createdAt} />
      {note.revisionCount > 0 ? <span className={styles.edited}> · {t('edited')}</span> : null}
      {note.source === 'migrated' ? <span className={styles.edited}> · {t('migrated')}</span> : null}
    </p>
  );
}
