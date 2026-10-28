'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import { MiniMap } from '@/components/map/mini-map';
import { NoteMeta } from '@/components/notes/note-meta';
import { useSession } from '@/components/session';
import { ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Facts, Panel, RecordLayout } from '@/components/ui/layout';
import type { CountryDto, NotePageDto, PropertyDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useCountries, usePicklist } from '@/lib/hooks/reference';

import styles from './properties.module.css';
import { useProperty, usePropertySummary } from './use-property';

/** The address lines in the country's order, with its local components (e.g. GhanaPost GPS). */
export function AddressLines({ address, country }: { address: PropertyDto['address']; country: CountryDto | undefined }) {
  const format = (country?.addressFormat ?? {}) as { local_components?: Array<{ key: string; label: string }> };
  const local = (format.local_components ?? []).filter((component) => address.localComponents[component.key]);
  return (
    <address className={styles.address}>
      {address.formatted ? <bdi>{address.formatted}</bdi> : null}
      {local.map((component) => (
        <span key={component.key} className={styles.localComponent}>
          {component.label}: <bdi className="ep-num">{address.localComponents[component.key]}</bdi>
        </span>
      ))}
    </address>
  );
}

/** P-2 overview: pinned notes, unit, listing, key and media summaries, and key facts. */
export function PropertyOverview({ id }: { id: string }) {
  const t = useTranslations('properties');
  const enums = useTranslations('enums');
  const format = useFormat();
  const { can } = useSession();
  const property = useProperty(id);
  const summary = usePropertySummary(id);
  const countries = useCountries();
  const record = property.data;
  const tenure = usePicklist('tenure', record?.address.countryCode);
  const pinned = useQuery({
    queryKey: ['record', 'notes-pinned', id],
    queryFn: () => bff<NotePageDto>(`properties/${id}/notes?filter[pinned]=true&limit=5`),
    enabled: can('property_note.view'),
  });
  if (!record) return null;
  const country = countries.data?.data.find((item) => item.code === record.address.countryCode);
  const counts = summary.data;
  const base = `/properties/${id}`;
  const area = (value: { value: number; unit: string } | null) => (value ? `${format.number(value.value)} ${t.has(`areaUnit.${value.unit}`) ? t(`areaUnit.${value.unit}`) : value.unit}` : null);
  const tenureLabel = record.tenureCode ? (tenure.data?.data.find((item) => item.code === record.tenureCode)?.label ?? record.tenureCode) : null;

  const main = (
    <>
      {can('property_note.view') ? (
        <Panel title={t('pinnedNotes')}>
          {pinned.isPending ? (
            <Skeleton />
          ) : pinned.isError ? (
            <ErrorNotice error={pinned.error} onRetry={() => void pinned.refetch()} />
          ) : pinned.data.data.length === 0 ? (
            <p className={styles.quiet}>{t('noPinned')}</p>
          ) : (
            <ul className={styles.pinned}>
              {pinned.data.data.map((note) => (
                <li key={note.id}>
                  <NoteMeta note={note} pinned />
                  <p dir="auto" className={styles.noteBody}>
                    {note.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
      <Panel>
        {summary.isPending ? (
          <div aria-busy="true">
            <Skeleton />
            <Skeleton width="70%" />
          </div>
        ) : summary.isError ? (
          <ErrorNotice error={summary.error} onRetry={() => void summary.refetch()} />
        ) : (
          <ul className={styles.summary}>
            <li>
              <NextLink href={`${base}/units`}>
                {t('summaryUnits', {
                  total: counts!.units.total,
                  available: counts!.units.available,
                  maintenance: counts!.units.underMaintenance,
                  unavailable: counts!.units.unavailable,
                })}
              </NextLink>
            </li>
            {counts!.listings ? (
              <li>
                <NextLink href={`${base}/listings`}>{t('summaryListings', { live: counts!.listings.live, draft: counts!.listings.draft })}</NextLink>
              </li>
            ) : null}
            {counts!.keys ? (
              <li>
                <NextLink href={`${base}/keys`}>
                  {counts!.keys.overdue > 0 ? <span aria-hidden="true">⚠ </span> : null}
                  {t('summaryKeys', { active: counts!.keys.active, out: counts!.keys.out, overdue: counts!.keys.overdue })}
                </NextLink>
              </li>
            ) : null}
            <li>
              <NextLink href={`${base}/media`}>
                {t('summaryMedia', { photos: counts!.media.photos, processing: counts!.media.processing, plans: counts!.media.plans, links: counts!.media.links })}
              </NextLink>
              {counts!.media.rejected > 0 ? <span className={styles.warn}> · {t('summaryRejected', { count: counts!.media.rejected })}</span> : null}
            </li>
          </ul>
        )}
      </Panel>
    </>
  );

  const aside = (
    <Panel title={t('keyFacts')} headingLevel={2}>
      <Facts
        items={[
          { label: t('address'), value: <AddressLines address={record.address} country={country} /> },
          {
            label: t('location'),
            value:
              record.address.latitude !== null ? (
                <>
                  {record.address.geocodeSource ? enums(`geocodeSource.${record.address.geocodeSource}`) : null}
                  {record.address.geocodeAccuracy ? ` · ${enums(`geocodeAccuracy.${record.address.geocodeAccuracy}`)}` : null}
                  {record.address.geocodedAt ? ` · ${format.date(record.address.geocodedAt)}` : null}
                </>
              ) : (
                t('noLocation')
              ),
          },
          tenureLabel ? { label: t('tenure'), value: record.tenureExpiresOn ? `${tenureLabel} ${t('tenureUntil', { date: format.date(record.tenureExpiresOn) })}` : tenureLabel } : null,
          record.titleReference ? { label: t('titleReference'), value: <bdi>{record.titleReference}</bdi> } : null,
          record.landArea ? { label: t('landArea'), value: <span className="ep-num">{area(record.landArea)}</span> } : null,
          record.yearBuilt ? { label: t('yearBuilt'), value: <span className="ep-num">{record.yearBuilt}</span> } : null,
          record.floorsCount !== null ? { label: t('floors'), value: <span className="ep-num">{format.number(record.floorsCount)}</span> } : null,
          { label: t('timezone'), value: <bdi>{record.timezone}</bdi> },
          { label: t('jurisdiction'), value: <bdi>{record.jurisdictionCode}</bdi> },
        ]}
      />
      {record.address.latitude !== null && record.address.longitude !== null ? (
        <MiniMap latitude={record.address.latitude} longitude={record.address.longitude} label={record.name ?? record.reference} />
      ) : null}
      {record.address.locationStale ? <Notice tone="warning" title={t('locationStaleNotice')} /> : null}
      {can('property.update') && record.archivedAt === null && (record.address.latitude === null || record.address.locationStale) ? (
        <NextLink href={`${base}/edit#location`}>{t('fixLocation')}</NextLink>
      ) : null}
    </Panel>
  );

  return <RecordLayout main={main} aside={aside} asideLabel={t('keyFacts')} />;
}
