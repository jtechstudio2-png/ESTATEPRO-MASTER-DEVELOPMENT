'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import { Ltr } from '@/components/crm/labels';
import { useSession } from '@/components/session';
import { LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Notice, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { Panel, Stack } from '@/components/ui/layout';
import type { PortalPreviewDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';

import styles from './contacts.module.css';

/**
 * LL-1 landlord view of one contact: the properties they own or we manage for
 * them, and what they could see in the landlord portal (#12, preview). The
 * preview uses the same server resolver as the future portal, judges
 * "current" in each property's time zone, is read-only, and is audited.
 * Management agreements and portal invitations arrive in Phase 7.
 */
export function PropertiesTab({ id }: { id: string }) {
  const t = useTranslations('landlord');
  const format = useFormat();
  const { can, readOnly } = useSession();
  const preview = useQuery({
    queryKey: ['record', 'portal-preview', id],
    queryFn: ({ signal }) => bff<PortalPreviewDto>(`contacts/${id}/portal-visibility-preview`, { signal }),
    // The preview is audited each time it is generated: never refetched in the background.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (preview.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton />
        <Skeleton />
      </div>
    );
  }
  if (preview.isError) return <ErrorNotice error={preview.error} onRetry={() => void preview.refetch()} />;
  const data = preview.data;
  return (
    <Stack>
      {!data.hasLandlordRole ? <Notice tone="info">{t('notLandlord')}</Notice> : null}
      <Panel
        title={t('propertiesTitle')}
        actions={
          can('property.update') && !readOnly ? (
            <LinkButton href={`/ownerships/new?contactId=${id}`}>{t('addOwnership')}</LinkButton>
          ) : undefined
        }
      >
        {data.properties.length === 0 ? (
          <EmptyState title={t('noProperties')} headingLevel={3}>
            {t('noPropertiesDetail')}
          </EmptyState>
        ) : (
          <ul className={styles.list}>
            {data.properties.map((property) => (
              <li key={property.id}>
                <span className={styles.itemMain}>
                  <NextLink href={`/properties/${property.id}`}>
                    <Ltr>{property.reference}</Ltr> {property.name ? <bdi dir="auto">{property.name}</bdi> : null}
                  </NextLink>
                  <span className={styles.meta}>
                    {property.basis
                      .map((basis) =>
                        basis.type === 'ownership'
                          ? t('ownershipBasis', { share: format.number(Number(basis.sharePercent ?? 100), { maximumFractionDigits: 2 }), from: format.date(basis.from), until: basis.until ? format.date(basis.until) : t('noEnd') })
                          : t('managementBasis', { from: format.date(basis.from), until: basis.until ? format.date(basis.until) : t('noEnd') }),
                      )
                      .join(' · ')}
                  </span>
                  <span className={styles.meta}>
                    {t('unitsLine', { count: property.units.length })}
                    {property.units.length > 0 ? `: ${property.units.map((unit) => unit.label).join(', ')}` : ''}
                  </span>
                  {property.listings.length > 0 ? (
                    <span className={styles.actions}>
                      {property.listings.map((listing) => (
                        <NextLink key={listing.id} href={`/listings/${listing.id}`}>
                          <Ltr>{listing.reference}</Ltr>
                          {listing.isPublished ? (
                            <>
                              {' '}
                              <StatusLabel tone="success">{t('published')}</StatusLabel>
                            </>
                          ) : null}
                        </NextLink>
                      ))}
                    </span>
                  ) : null}
                  <span className={styles.meta}>{t('timezone', { zone: property.timezone })}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.meta}>{t('phase7')}</p>
      </Panel>
      <Panel title={t('previewTitle')}>
        <p>{t('previewIntro', { when: format.dateTime(data.generatedAt) })}</p>
        <p>
          <strong>{t('visible')}</strong> {data.properties.length === 0 ? t('nothingVisible') : data.properties.map((property) => property.name ?? property.reference).join(', ')}
        </p>
        <p>
          <strong>{t('notVisible')}</strong> {data.notVisibleCodes.map((code) => t(`notVisibleCode.${code as 'other_owners'}`)).join(' · ')}
        </p>
        {data.limitedToYourAccess ? <Notice tone="info">{t('limited')}</Notice> : null}
        <p className={styles.meta}>{t('auditNote')}</p>
      </Panel>
    </Stack>
  );
}
