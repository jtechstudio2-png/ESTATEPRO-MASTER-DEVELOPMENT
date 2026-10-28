'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Input, Label, SearchField } from 'react-aria-components';

import { Button } from './button';
import fieldStyles from './field.module.css';
import styles from './list-controls.module.css';

export interface Chip {
  key: string;
  label: string;
  onRemove: () => void;
}

/**
 * Filter bar (UI checklist §2): the most used filters, a search box, and the
 * active filters as removable chips with "Clear all".
 */
export function FilterBar({ search, children, chips, onClearAll }: { search?: ReactNode; children?: ReactNode; chips: Chip[]; onClearAll: () => void }) {
  const t = useTranslations('list');
  const chipList = useRef<HTMLUListElement>(null);
  return (
    <section className={styles.bar} aria-label={t('filters')}>
      <div className={styles.controls}>
        {search}
        {children}
      </div>
      {chips.length > 0 ? (
        <div className={styles.chips}>
          <span className={styles.chipsLabel}>{t('activeFilters')}</span>
          <ul ref={chipList} className={styles.chipList}>
            {chips.map((chip, index) => (
              <li key={chip.key}>
                <button
                  type="button"
                  className={styles.chip}
                  aria-label={t('removeFilter', { filter: chip.label })}
                  onClick={() => {
                    chip.onRemove();
                    // Keep focus in the chip list: the next chip, or the bar.
                    requestAnimationFrame(() => {
                      const buttons = chipList.current?.querySelectorAll('button');
                      const next = buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)];
                      next?.focus();
                    });
                  }}
                >
                  <bdi>{chip.label}</bdi> <span aria-hidden="true">✕</span>
                </button>
              </li>
            ))}
          </ul>
          <Button size="small" variant="quiet" onPress={onClearAll}>
            {t('clearAll')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Text search, 2+ characters, debounced 300 ms (UI checklist §2). */
export function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === value) return;
    if (trimmed.length === 1) return;
    const timer = setTimeout(() => onChange(trimmed), 300);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);
  return (
    <SearchField className={`${fieldStyles.field} ${styles.search}`} value={text} onChange={setText} onClear={() => onChange('')}>
      <Label className={fieldStyles.label}>{label}</Label>
      <Input className={fieldStyles.input} />
    </SearchField>
  );
}

export function LoadMore({ hasMore, loading, onLoad, shown }: { hasMore: boolean; loading: boolean; onLoad: () => void; shown: number }) {
  const t = useTranslations('list');
  return (
    <>
      <span className={styles.count}>{hasMore ? t('shownMore', { count: shown }) : t('shown', { count: shown })}</span>
      {hasMore ? (
        <Button onPress={onLoad} busy={loading}>
          {t('loadMore')}
        </Button>
      ) : null}
    </>
  );
}
