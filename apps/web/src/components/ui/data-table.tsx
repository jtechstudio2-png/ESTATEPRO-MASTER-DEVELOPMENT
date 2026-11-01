'use client';

import NextLink from 'next/link';
import type { ReactNode } from 'react';

import styles from './table.module.css';

export interface Column<R> {
  key: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  align?: 'start' | 'end';
  /** Shown on the mobile card (at most two besides the identifier and status). */
  onCard?: boolean;
  /** Sorted column, for aria-sort. */
  sort?: 'ascending' | 'descending';
}

interface DataTableProps<R> {
  /** Names the list for assistive technology (table caption). */
  caption: string;
  rows: R[];
  rowKey: (row: R) => string;
  /** First column: reference and name, linking to the record when it has a page of its own (UI checklist §1). */
  identifier: { header: ReactNode; href?: (row: R) => string; label: (row: R) => ReactNode; secondary?: (row: R) => ReactNode };
  status?: { header: ReactNode; cell: (row: R) => ReactNode };
  columns: Array<Column<R>>;
  /** Primary row action and the overflow menu (last column). */
  actions?: (row: R) => ReactNode;
  actionsHeader?: string;
  sortNote?: ReactNode;
  footer?: ReactNode;
  /** Optional selection column (bulk actions). */
  selection?: { isSelected: (row: R) => boolean; toggle: (row: R) => void; label: (row: R) => string; header: ReactNode };
}

/**
 * Real table markup on wide screens; labelled cards below 768 px (UI
 * checklist §1). The identifier cell is the row header.
 */
export function DataTable<R>({ caption, rows, rowKey, identifier, status, columns, actions, actionsHeader, sortNote, footer, selection }: DataTableProps<R>) {
  return (
    <div>
      {sortNote ? <p className={styles.sortNote}>{sortNote}</p> : null}
      <div className={styles.region} role="region" aria-label={caption} tabIndex={0}>
        <table className={styles.table}>
          <caption className="ep-visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {selection ? <th scope="col">{selection.header}</th> : null}
              <th scope="col">{identifier.header}</th>
              {status ? <th scope="col">{status.header}</th> : null}
              {columns.map((column) => (
                <th key={column.key} scope="col" className={column.align === 'end' ? styles.end : undefined} aria-sort={column.sort}>
                  {column.header}
                </th>
              ))}
              {actions ? (
                <th scope="col">
                  <span className="ep-visually-hidden">{actionsHeader}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {selection ? (
                  <td>
                    <input type="checkbox" checked={selection.isSelected(row)} onChange={() => selection.toggle(row)} aria-label={selection.label(row)} />
                  </td>
                ) : null}
                <th scope="row">
                  {identifier.href ? <NextLink href={identifier.href(row)}>{identifier.label(row)}</NextLink> : identifier.label(row)}
                  {identifier.secondary ? <span className={styles.secondary}>{identifier.secondary(row)}</span> : null}
                </th>
                {status ? <td>{status.cell(row)}</td> : null}
                {columns.map((column) => (
                  <td key={column.key} className={column.align === 'end' ? styles.end : undefined}>
                    {column.cell(row)}
                  </td>
                ))}
                {actions ? <td>{actions(row)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles.cards} aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                {identifier.href ? (
                  <NextLink href={identifier.href(row)}>
                    <strong>{identifier.label(row)}</strong>
                  </NextLink>
                ) : (
                  <strong>{identifier.label(row)}</strong>
                )}
                {identifier.secondary ? <span className={styles.secondary}>{identifier.secondary(row)}</span> : null}
              </div>
              {status ? status.cell(row) : null}
            </div>
            <dl className={styles.cardFields}>
              {columns
                .filter((column) => column.onCard)
                .slice(0, 2)
                .map((column) => (
                  <div key={column.key} style={{ display: 'contents' }}>
                    <dt>{column.header}</dt>
                    <dd>{column.cell(row)}</dd>
                  </div>
                ))}
            </dl>
            {actions ? <div>{actions(row)}</div> : null}
          </li>
        ))}
      </ul>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}
