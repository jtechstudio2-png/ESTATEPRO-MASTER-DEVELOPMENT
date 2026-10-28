'use client';

import NextLink from 'next/link';
import type { ReactNode } from 'react';

import styles from './layout.module.css';

export function Page({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}

interface PageHeaderProps {
  title: ReactNode;
  back?: { href: string; label: string };
  subtitle?: ReactNode;
  actions?: ReactNode;
}

/** One h1 per page (UI checklist §8), with the record's primary action. */
export function PageHeader({ title, back, subtitle, actions }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        {back ? (
          <NextLink href={back.href} className={styles.back}>
            <span aria-hidden="true" className="ep-mirror">
              ‹
            </span>{' '}
            {back.label}
          </NextLink>
        ) : null}
        <h1>{title}</h1>
        {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

export interface TabLink {
  href: string;
  label: string;
  count?: number | null;
  current: boolean;
}

/** Record tabs are links (the URL holds the tab, Phase 3 07 §1). */
export function RecordTabs({ label, tabs }: { label: string; tabs: TabLink[] }) {
  return (
    <nav aria-label={label} className={styles.tabs}>
      {tabs.map((tab) => (
        <NextLink key={tab.href} href={tab.href} className={styles.tab} aria-current={tab.current ? 'page' : undefined} scroll={false}>
          {tab.label}
          {tab.count !== undefined && tab.count !== null ? <span className="ep-num">{tab.count}</span> : null}
        </NextLink>
      ))}
    </nav>
  );
}

export function RecordLayout({ main, aside, asideLabel }: { main: ReactNode; aside: ReactNode; asideLabel: string }) {
  return (
    <div className={styles.record}>
      <div className={styles.stack}>{main}</div>
      <aside aria-label={asideLabel} className={styles.stack}>
        {aside}
      </aside>
    </div>
  );
}

export function Panel({ title, children, actions, headingLevel = 2 }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={styles.panel}>
      {title || actions ? (
        <div className={styles.header}>
          {title ? <Heading>{title}</Heading> : null}
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Facts({ items }: { items: Array<{ label: ReactNode; value: ReactNode } | null | false> }) {
  return (
    <dl className={styles.facts}>
      {items
        .filter((item): item is { label: ReactNode; value: ReactNode } => Boolean(item))
        .map((item, index) => (
          <div key={index} style={{ display: 'contents' }}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Stack({ children }: { children: ReactNode }) {
  return <div className={styles.stack}>{children}</div>;
}

export function Cluster({ children }: { children: ReactNode }) {
  return <div className={styles.cluster}>{children}</div>;
}

export function Fieldset({ legend, children }: { legend: ReactNode; children: ReactNode }) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

export const formClass = styles.form;
