'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useSession } from '@/components/session';
import { Dialog } from '@/components/ui/dialog';
import { ErrorNotice } from '@/components/ui/feedback';
import fieldStyles from '@/components/ui/field.module.css';
import { bff, query } from '@/lib/bff';

import styles from './app-shell.module.css';

interface SearchHit {
  id: string;
  reference: string;
  title: string;
  context: string | null;
  propertyId: string | null;
}

interface SearchGroup {
  hits: SearchHit[];
  hasMore: boolean;
}

interface SearchResult {
  properties: SearchGroup | null;
  units: SearchGroup | null;
  listings: SearchGroup | null;
}

type GroupKey = keyof SearchResult;

interface Recent {
  group: GroupKey;
  hit: SearchHit;
}

const RECENT_PREFIX = 'ep:recent:';
const RECENT_MAX = 8;

export function hitHref(group: GroupKey, hit: SearchHit): string {
  if (group === 'properties') return `/properties/${hit.id}`;
  if (group === 'listings') return `/listings/${hit.id}`;
  return `/properties/${hit.propertyId ?? ''}/units?unit=${hit.id}`;
}

/** Recent items are per member of a company (S-3); other companies' lists are removed. */
function readRecent(membershipId: string): Recent[] {
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(RECENT_PREFIX) && key !== RECENT_PREFIX + membershipId) window.localStorage.removeItem(key);
    }
    const value = JSON.parse(window.localStorage.getItem(RECENT_PREFIX + membershipId) ?? '[]') as unknown;
    return Array.isArray(value) ? (value as Recent[]).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(membershipId: string, items: Recent[]): void {
  try {
    window.localStorage.setItem(RECENT_PREFIX + membershipId, JSON.stringify(items.slice(0, RECENT_MAX)));
  } catch {
    // Storage unavailable (private mode): recent items are a convenience only.
  }
}

/**
 * Global search (S-3): properties, units and listings by reference, name or
 * address, grouped, with keyboard navigation as a combobox with a listbox.
 */
export function GlobalSearch({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('search');
  const router = useRouter();
  const { session } = useSession();
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<Recent[]>([]);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setText('');
    setTerm('');
    setActive(0);
    setRecent(readRecent(session.membershipId));
  }, [isOpen, session.membershipId]);

  useEffect(() => {
    const trimmed = text.trim();
    const timer = setTimeout(() => setTerm(trimmed.length >= 2 ? trimmed : ''), 250);
    return () => clearTimeout(timer);
  }, [text]);

  const result = useQuery({
    queryKey: ['search', session.company.id, term],
    queryFn: ({ signal }) => bff<SearchResult>(`search${query({ q: term })}`, { signal }),
    enabled: isOpen && term.length >= 2,
    staleTime: 30_000,
  });

  const groups = useMemo(() => {
    const data = result.data;
    if (term.length < 2 || !data) return [] as Array<{ key: GroupKey; group: SearchGroup }>;
    return (['properties', 'units', 'listings'] as const)
      .map((key) => ({ key, group: data[key] }))
      .filter((entry): entry is { key: GroupKey; group: SearchGroup } => entry.group !== null && entry.group.hits.length > 0);
  }, [result.data, term]);

  const items = useMemo<Recent[]>(
    () => (term.length >= 2 ? groups.flatMap(({ key, group }) => group.hits.map((hit) => ({ group: key, hit }))) : recent),
    [groups, recent, term],
  );

  useEffect(() => setActive(0), [items]);

  const open = useCallback(
    (item: Recent, newTab = false) => {
      const href = hitHref(item.group, item.hit);
      const next = [item, ...readRecent(session.membershipId).filter((entry) => entry.hit.id !== item.hit.id)];
      writeRecent(session.membershipId, next);
      if (newTab) {
        window.open(href, '_blank', 'noopener');
        return;
      }
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router, session.membershipId],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + items.length) % items.length);
    } else if (event.key === 'Home' && event.ctrlKey) {
      setActive(0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[active];
      if (item) open(item, event.ctrlKey || event.metaKey);
    }
  };

  const optionId = (index: number) => `${listId}-${index}`;
  let index = -1;
  const renderHit = (item: Recent) => {
    index += 1;
    const current = index;
    return (
      <li
        key={`${item.group}-${item.hit.id}`}
        id={optionId(current)}
        role="option"
        aria-selected={current === active}
        className={styles.searchHit}
        data-active={current === active || undefined}
        onMouseEnter={() => setActive(current)}
        onClick={(event) => open(item, event.ctrlKey || event.metaKey)}
      >
        <span className="ep-num">
          <bdi>{item.hit.reference}</bdi>
        </span>{' '}
        · <bdi>{item.hit.title}</bdi>
        {item.hit.context ? (
          <span className={styles.searchContext}>
            {' '}
            · <bdi>{item.hit.context}</bdi>
          </span>
        ) : null}
      </li>
    );
  };

  const searching = term.length >= 2;
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} title={t('title')} size="wide">
      <div className={fieldStyles.field}>
        <label htmlFor={`${listId}-input`} className={fieldStyles.label}>
          {t('label')}
        </label>
        <input
          ref={input}
          id={`${listId}-input`}
          className={fieldStyles.input}
          type="search"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={items.length > 0 ? listId : undefined}
          aria-activedescendant={items.length > 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <p className={fieldStyles.description}>{t('hint')}</p>
      </div>
      <div aria-live="polite" className="ep-visually-hidden">
        {searching && result.isSuccess ? t('resultCount', { count: items.length }) : ''}
      </div>
      {result.isError ? <ErrorNotice error={result.error} onRetry={() => void result.refetch()} /> : null}
      {!searching && recent.length === 0 ? <p className={styles.searchEmpty}>{t('start')}</p> : null}
      {searching && result.isPending ? <p className={styles.searchEmpty}>{t('searching')}</p> : null}
      {searching && result.isSuccess && groups.length === 0 ? <p className={styles.searchEmpty}>{t('none', { term })}</p> : null}
      {items.length > 0 ? (
        <div id={listId} role="listbox" aria-label={searching ? t('results') : t('recent')} className={styles.searchResults}>
          {searching ? (
            groups.map(({ key, group }) => (
              <ul key={key} role="group" aria-label={t(key)}>
                <li role="presentation" className={styles.searchGroup} aria-hidden="true">
                  {t(key)}
                </li>
                {group.hits.map((hit) => renderHit({ group: key, hit }))}
              </ul>
            ))
          ) : (
            <ul role="group" aria-label={t('recent')}>
              <li role="presentation" className={styles.searchGroup} aria-hidden="true">
                {t('recent')}
              </li>
              {recent.map(renderHit)}
            </ul>
          )}
        </div>
      ) : null}
      {searching && groups.some(({ key, group }) => group.hasMore && key !== 'units') ? (
        <ul className={styles.searchMoreList}>
          {groups
            .filter(({ key, group }) => group.hasMore && key !== 'units')
            .map(({ key }) => (
              <li key={key}>
                <NextLink className={styles.searchMore} href={`/${key}${query({ q: term })}`} onClick={() => onOpenChange(false)}>
                  {t('seeAll', { group: t(key) })}
                </NextLink>
              </li>
            ))}
        </ul>
      ) : null}
    </Dialog>
  );
}
