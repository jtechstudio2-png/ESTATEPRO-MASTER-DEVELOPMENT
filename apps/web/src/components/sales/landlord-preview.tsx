'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { SelectField } from '@/components/ui/fields';
import { Panel } from '@/components/ui/layout';
import type { LandlordPreviewDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';

import { MoneyText, ZonedTime } from './sales-labels';
import styles from './sales.module.css';

/**
 * LP-1 what this landlord could see for one listing (S4): read only, each
 * opening audited by the API, every section limited to the member's own offer,
 * deal and viewing scope. Generated once per choice, never in the background.
 */
export function LandlordListingPreview({ contactId, listings }: { contactId: string; listings: Array<{ id: string; reference: string }> }) {
  const t = useTranslations('sales');
  const format = useFormat();
  const [listingId, setListingId] = useState<string>('');
  const preview = useQuery({
    queryKey: ['record', 'landlord-listing-preview', contactId, listingId],
    queryFn: ({ signal }) => bff<LandlordPreviewDto>(`contacts/${contactId}/portal-visibility-preview/listings/${listingId}`, { signal }),
    enabled: listingId !== '',
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (listings.length === 0) return null;
  const data = preview.data;
  return (
    <Panel title={t('landlordViewTitle')}>
      <SelectField label={t('listing')} value={listingId} onChange={setListingId} placeholder={t('chooseListing')} options={listings.map((listing) => ({ id: listing.id, label: listing.reference }))} />
      <p className={styles.meta}>{t('readOnlyAudited')}</p>
      {listingId === '' ? null : preview.isPending ? (
        <Skeleton />
      ) : preview.isError ? (
        <ErrorNotice error={preview.error} onRetry={() => void preview.refetch()} />
      ) : data ? (
        <>
          {data.limitedToYourAccess ? <Notice tone="info">{t('limitedToYourAccess')}</Notice> : null}
          <h3>{t('offersTitle')}</h3>
          {data.offers === null ? (
            <p>{t('sectionNotShown')}</p>
          ) : data.offers.length === 0 ? (
            <p>{t('noneSinceLink')}</p>
          ) : (
            <ul className={styles.list}>
              {data.offers.map((offer) => (
                <li key={offer.id}>
                  <span className={styles.itemMain}>
                    <span>
                      <MoneyText money={offer.amount} /> · <bdi dir="auto">{offer.offeredByName}</bdi> · {t(`offerStatus.${offer.status as 'submitted'}`)}
                    </span>
                    {offer.conditions ? (
                      <span className={styles.body} dir="auto">
                        {offer.conditions}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.meta}>{format.date(offer.submittedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <h3>{t('dealsTitle')}</h3>
          {data.deals === null ? (
            <p>{t('sectionNotShown')}</p>
          ) : data.deals.length === 0 ? (
            <p>{t('noneSinceLink')}</p>
          ) : (
            <ul className={styles.list}>
              {data.deals.map((deal) => (
                <li key={deal.id}>
                  <span className={styles.itemMain}>
                    <span>
                      <bdi dir="auto">{deal.stageName}</bdi> · {t(`dealStatus.${deal.status}`)}
                    </span>
                    <span className={styles.meta}>{t('milestoneProgress', { done: deal.milestones.filter((milestone) => milestone.done).length, total: deal.milestones.length })}</span>
                    {deal.milestones.length > 0 ? (
                      <ul>
                        {deal.milestones.map((milestone, index) => (
                          <li key={index}>
                            <span aria-hidden="true">{milestone.done ? '✓ ' : '○ '}</span>
                            <span className="ep-visually-hidden">{milestone.done ? t('milestoneStateDone') : t('milestoneStateOpen')} </span>
                            <bdi dir="auto">{milestone.name}</bdi>
                            {milestone.dueDate ? ` · ${t('dueOn', { date: format.date(milestone.dueDate) })}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3>{t('viewingsTitle')}</h3>
          {data.viewings === null ? (
            <p>{t('sectionNotShown')}</p>
          ) : data.viewings.length === 0 ? (
            <p>{t('noneSinceLink')}</p>
          ) : (
            <ul className={styles.list}>
              {data.viewings.map((viewing) => (
                <li key={viewing.id}>
                  <span className={styles.itemMain}>
                    <ZonedTime iso={viewing.scheduledStart} timeZone={viewing.timezone} />
                    <span>
                      {t(`viewingTypeName.${viewing.viewingType}`)} · {t(`viewingStatus.${viewing.status}`)}
                      {viewing.outcome ? ` · ${t(`outcomeName.${viewing.outcome as 'interested'}`)}` : ''}
                    </span>
                    {viewing.feedback ? (
                      <span className={styles.body} dir="auto">
                        {viewing.feedback}
                      </span>
                    ) : viewing.status === 'completed' ? (
                      <span className={styles.meta}>{t('feedbackNotSharedShort')}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p>
            <strong>{t('neverShown')}</strong> {data.notShown.map((code) => t(`notShown.${code}`)).join(' · ')}
          </p>
        </>
      ) : null}
    </Panel>
  );
}
