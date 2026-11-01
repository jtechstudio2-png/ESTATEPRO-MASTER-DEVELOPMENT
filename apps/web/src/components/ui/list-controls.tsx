'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Input, Label, SearchField } from 'react-aria-components';

import { Button } from './button';
import { SelectField } from './fields';
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

const ANY = '__any__';

/** A filter drop-down with "Any" first; null means the filter is off. */
export function FilterSelect({ label, value, onChange, options }: { label: string; value: string | null; onChange: (value: string | null) => void; options: Array<{ id: string; label: string }> }) {
  const t = useTranslations('list');
  return (
    <div className={styles.filter}>
      <SelectField label={label} value={value ?? ANY} onChange={(next) => onChange(next === ANY ? null : next)} options={[{ id: ANY, label: t('any') }, ...options]} />
    </div>
  );
}

/** "Sorted by: …" with the sorts the API allows (UI checklist §1). */
export function SortSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: Array<{ id: string; label: string }> }) {
  const t = useTranslations('list');
  return (
    <div className={styles.filter}>
      <SelectField label={t('sort')} value={value} onChange={onChange} options={options} />
    </div>
  );
}

/** "More filters": the less used filters behind a disclosure (UI checklist §2). */
export function MoreFilters({ children, activeCount }: { children: ReactNode; activeCount: number }) {
  const t = useTranslations('list');
  const [open, setOpen] = useState(activeCount > 0);
  const id = useId();
  return (
    <>
      <div className={styles.filter}>
        <Button onPress={() => setOpen(!open)} aria-expanded={open} aria-controls={id}>
          {t('moreFilters')}
          {activeCount > 0 ? ` (${activeCount})` : ''}
        </Button>
      </div>
      <div id={id} hidden={!open} className={styles.more} style={{ flexBasis: '100%' }}>
        {children}
      </div>
    </>
  );
}

export const listStyles = styles;
