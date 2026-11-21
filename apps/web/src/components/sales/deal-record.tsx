'use client';

import NextLink from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ActivityTimeline } from '@/components/activity/timeline';
import { useAnnounce } from '@/components/announcer';
import { Ltr } from '@/components/crm/labels';
import { telHref, useContact } from '@/components/crm/use-crm';
import { useSession } from '@/components/session';
import { Button, buttonClass, LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Facts, Page, PageHeader, Panel, RecordLayout } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { When } from '@/components/ui/when';
import type { DealDto, DealMilestoneDto } from '@/lib/api-schema';
import { useDocumentTitle } from '@/lib/hooks/document-title';
import { useFormat } from '@/lib/hooks/format';
import { usePicklist } from '@/lib/hooks/reference';
import { ApiError } from '@/lib/problem';

import {
  AddPartyDialog,
  AgentsDialog,
  CompleteDialog,
  CompleteMilestoneDialog,
  EditDealDialog,
  EditMilestoneDialog,
  ExchangeDialog,
  LoseDialog,
  MoveStageDialog,
  ReassignDialog,
  RemovePartyDialog,
} from './deal-dialogs';
import { OffersPanel } from './offers';
import { DealStatusLabel, MoneyText, StalledLabel } from './sales-labels';
import styles from './sales.module.css';
import { STAGE_CLASSES } from './sales-rules';
import { useDeal, useNarrow } from './use-sales';
import { ViewingList } from './viewing-list';

const TABS = ['overview', 'offers', 'viewings', 'milestones', 'timeline', 'history'] as const;
type Tab = (typeof TABS)[number];

type DialogState =
  | { kind: 'edit' | 'move' | 'reassign' | 'agents' | 'party' | 'exchange' | 'complete' | 'lose' }
  | { kind: 'removeParty'; party: DealDto['parties'][number] }
  | { kind: 'milestoneDone' | 'milestoneEdit'; milestone: DealMilestoneDto }
  | null;

/** The stage path for this deal type: letting deals end at "terms agreed" (P6-D2), so no contract step. */
function pathClasses(deal: DealDto): string[] {
  const classes = STAGE_CLASSES.filter((stageClass) => stageClass !== 'closed_lost' && !(deal.dealType === 'letting' && stageClass === 'contract'));
  return deal.status === 'lost' ? [...classes.filter((stageClass) => stageClass !== 'closed_won'), 'closed_lost'] : classes;
}

/**
 * DL-3 deal record: the stage path, the next step the deal needs, and tabs for
 * offers (O-1), viewings, milestones (DL-5), the read-only timeline (W-A2) and
 * history. Every action comes from the API's `access` flags; a closed deal
 * shows a banner and no actions. Phones get the reduced scope (W-D4).
 */
export function DealRecord({ id }: { id: string }) {
  const t = useTranslations('sales');
  const common = useTranslations('common');
  const errors = useTranslations('errors');
  const announce = useAnnounce();
  const format = useFormat();
  const narrow = useNarrow();
  const { readOnly } = useSession();
  const search = useSearchParams();
  const pathname = usePathname();
  const deal = useDeal(id);
  const lostReasons = usePicklist('lost_reason');
  const contact = useContact(deal.data?.primaryContact.id ?? '', deal.data !== undefined);
  const [dialog, setDialog] = useState<DialogState>(null);
  useDocumentTitle(deal.data ? `${deal.data.reference} · ${deal.data.primaryContact.name}` : null);
  const rawTab = search.get('tab');
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'overview';

  if (deal.isPending) {
    return (
      <Page>
        <div aria-busy="true">
          <Skeleton width="40%" />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (deal.isError) {
    return (
      <Page>
        {deal.error instanceof ApiError && deal.error.status === 404 ? (
          <EmptyState title={t('dealNotFound')} action={<LinkButton href="/deals">{t('backToDeals')}</LinkButton>}>
            {errors('notFoundDetail')}
          </EmptyState>
        ) : (
          <ErrorNotice error={deal.error} onRetry={() => void deal.refetch()} />
        )}
      </Page>
    );
  }

  const record = deal.data;
  const access = record.access;
  const open = record.status === 'open' && !readOnly;
  const canEdit = open && access.canEdit;
  const phone = contact.data?.primaryPhone ?? null;
  const doneCount = record.milestones.filter((milestone) => milestone.completedAt !== null).length;
  const nextMilestone = record.milestones.find((milestone) => milestone.completedAt === null) ?? null;
  const close = () => setDialog(null);

  const menu: MenuAction[] = [
    {
      id: 'copy',
      label: common('copyReference'),
      onAction: () => void navigator.clipboard?.writeText(record.reference).then(() => announce(common('copied', { value: record.reference }))),
    },
  ];
  if (open) {
    if (access.nextStages.length > 0) menu.push({ id: 'move', label: t('moveStageAction'), onAction: () => setDialog({ kind: 'move' }) });
    if (access.canReassign) menu.push({ id: 'reassign', label: t('reassignAction'), onAction: () => setDialog({ kind: 'reassign' }) });
    if (canEdit) menu.push({ id: 'edit', label: t('editDealAction'), onAction: () => setDialog({ kind: 'edit' }) });
    if (access.canExchange) menu.push({ id: 'exchange', label: t('exchangeAction'), onAction: () => setDialog({ kind: 'exchange' }) });
    if (access.canComplete && !narrow) menu.push({ id: 'complete', label: t('completeAction'), onAction: () => setDialog({ kind: 'complete' }) });
    if (access.canLose) menu.push({ id: 'lose', label: t('loseAction'), onAction: () => setDialog({ kind: 'lose' }), danger: true });
  }

  const tabHref = (id: Tab) => (id === 'overview' ? pathname : `${pathname}?tab=${id}`);
  const classes = pathClasses(record);
  const currentIndex = classes.indexOf(record.stage.stageClass);

  const nextStep = (
    <Panel title={t('nextStep')}>
      {record.status === 'won' ? (
        <Notice tone="success" title={t('wonBanner', { date: record.closedAt ? format.date(record.closedAt) : '' })} />
      ) : record.status === 'lost' ? (
        <Notice tone="neutral" title={t('lostBanner', { reason: lostReasons.data?.data.find((value) => value.code === record.lostReasonCode)?.label ?? record.lostReasonCode ?? '' })}>
          {record.lostNotes ? <span dir="auto">{record.lostNotes}</span> : null}
        </Notice>
      ) : record.dealType === 'letting' && record.stage.stageClass === 'offer_accepted' ? (
        <Notice tone="info" title={t('termsAgreed')}>
          {t('leasesPhase7')}
        </Notice>
      ) : record.stage.stageClass === 'offer_accepted' ? (
        <>
          {record.identity.required && record.identity.unverifiedBuyerIds.length > 0 ? (
            <Notice tone="warning" title={t('buyersUnverified', { count: record.identity.unverifiedBuyerIds.length })}>
              {t('exchangeNeedsVerified')}
            </Notice>
          ) : null}
          {access.canExchange && !readOnly ? (
            <Button variant="primary" onPress={() => setDialog({ kind: 'exchange' })}>
              {t('exchangeAction')}
            </Button>
          ) : (
            <p className={styles.meta}>{t('exchangeNotYet')}</p>
          )}
        </>
      ) : record.stage.stageClass === 'contract' ? (
        <>
          <p>{t('milestoneProgress', { done: doneCount, total: record.milestones.length })}</p>
          {access.canComplete && !readOnly && !narrow ? (
            <Button variant="primary" onPress={() => setDialog({ kind: 'complete' })}>
              {t('completeAction')}
            </Button>
          ) : narrow && access.canComplete ? (
            <p className={styles.meta}>{t('completeOnDesktop')}</p>
          ) : (
            <p className={styles.meta}>{t('completeWho')}</p>
          )}
        </>
      ) : (
        <>
          <p>{record.listing ? t('earlyNextStep') : t('needsListing')}</p>
          <span className={styles.actions}>
            {open && access.nextStages.length > 0 ? <Button onPress={() => setDialog({ kind: 'move' })}>{t('moveStageAction')}</Button> : null}
            {record.listing ? <LinkButton href={tabHref('offers')}>{t('goToOffers')}</LinkButton> : null}
          </span>
        </>
      )}
      {record.acceptedOffer ? (
        <p>
          {t('acceptedOffer')}: <MoneyText money={record.acceptedOffer.amount} /> · <bdi dir="auto">{record.acceptedOffer.offeredBy.name}</bdi>
        </p>
      ) : null}
      {record.sale ? (
        <Facts
          items={[
            { label: t('saleReference'), value: <Ltr>{record.sale.reference}</Ltr> },
            { label: t('saleStatus'), value: t(`saleStatusName.${record.sale.status}`) },
            { label: t('agreedPrice'), value: <MoneyText money={record.sale.agreedPrice} /> },
            record.sale.contractSignedOn ? { label: t('signedOn'), value: format.date(record.sale.contractSignedOn) } : null,
            record.sale.completionDueOn ? { label: t('completionDue'), value: format.date(record.sale.completionDueOn) } : null,
            record.sale.completedOn ? { label: t('completedOn'), value: format.date(record.sale.completedOn) } : null,
            record.sale.titleTransferRef ? { label: t('titleRef'), value: <Ltr>{record.sale.titleTransferRef}</Ltr> } : null,
          ]}
        />
      ) : null}
      {record.milestones.length > 0 ? (
        <p className={styles.meta}>
          {t('milestoneProgress', { done: doneCount, total: record.milestones.length })}
          {nextMilestone ? ` · ${t('nextMilestone', { name: nextMilestone.name })}` : ''}
          {nextMilestone?.dueDate ? ` ${format.date(nextMilestone.dueDate)}` : ''}
        </p>
      ) : null}
    </Panel>
  );

  const milestones = (
    <Panel title={t('milestonesTitle')}>
      {record.milestones.length === 0 ? (
        <p>{t('noMilestones')}</p>
      ) : (
        <ol className={styles.list}>
          {record.milestones.map((milestone) => (
            <li key={milestone.id}>
              <span className={styles.itemMain}>
                <span>
                  <span aria-hidden="true">{milestone.completedAt ? '✓ ' : '○ '}</span>
                  <span className="ep-visually-hidden">{milestone.completedAt ? t('milestoneStateDone') : t('milestoneStateOpen')} </span>
                  <bdi dir="auto">{milestone.name}</bdi>
                </span>
                <span className={styles.meta}>
                  {milestone.automatic ? t('automatic') : milestone.isRequired ? t('required') : t('optional')}
                  {milestone.completedAt ? (
                    <>
                      {' · '}
                      <When iso={milestone.completedAt} />
                      {milestone.completedBy ? ` · ${milestone.completedBy.name}` : ''}
                    </>
                  ) : milestone.dueDate ? (
                    ` · ${t('dueOn', { date: format.date(milestone.dueDate) })}`
                  ) : null}
                  {milestone.overdue ? (
                    <>
                      {' · '}
                      <span aria-hidden="true">⚠ </span>
                      {t('overdue')}
                    </>
                  ) : null}
                  {milestone.automatic && milestone.completedAt === null ? ` · ${t('automaticWaits')}` : ''}
                </span>
                {milestone.notes ? (
                  <span className={styles.body} dir="auto">
                    {milestone.notes}
                  </span>
                ) : null}
              </span>
              {open && access.canEdit && milestone.completedAt === null && !milestone.automatic ? (
                <span className={styles.actions}>
                  <Button size="small" variant="primary" onPress={() => setDialog({ kind: 'milestoneDone', milestone })} aria-label={t('markDoneNamed', { name: milestone.name })}>
                    {t('markDone')}
                  </Button>
                  <Button size="small" onPress={() => setDialog({ kind: 'milestoneEdit', milestone })} aria-label={t('editNamed', { name: milestone.name })}>
                    {t('edit')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );

  const history = (
    <>
      <Panel title={t('stageHistory')}>
        <ol className={styles.list}>
          {[...record.stageHistory].reverse().map((change, index) => (
            <li key={index}>
              <span className={styles.itemMain}>
                <span>{change.fromStage ? t('stageChange', { from: change.fromStage.name, to: change.toStage.name }) : t('stageStart', { to: change.toStage.name })}</span>
                <span className={styles.meta}>
                  <When iso={change.changedAt} /> {change.changedBy ? `· ${change.changedBy.name}` : ''}
                </span>
                {change.note ? (
                  <span className={styles.body} dir="auto">
                    {change.note}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </Panel>
      <Panel title={t('ownerHistory')}>
        {record.assignments.length === 0 ? (
          <p>{t('noReassignments')}</p>
        ) : (
          <ol className={styles.list}>
            {[...record.assignments].reverse().map((assignment, index) => (
              <li key={index}>
                <span className={styles.itemMain}>
                  <span>{assignment.from ? t('assignmentLine', { from: assignment.from.name, to: assignment.to.name }) : t('assignmentStart', { to: assignment.to.name })}</span>
                  <span className={styles.meta}>
                    <When iso={assignment.assignedAt} /> {assignment.assignedBy ? `· ${assignment.assignedBy.name}` : ''}
                  </span>
                  {assignment.note ? (
                    <span className={styles.body} dir="auto">
                      {assignment.note}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );

  const main =
    tab === 'offers' ? (
      <OffersPanel deal={record} />
    ) : tab === 'viewings' ? (
      <ViewingList dealId={record.id} listingId={record.listing?.id ?? null} />
    ) : tab === 'milestones' ? (
      milestones
    ) : tab === 'timeline' ? (
      <ActivityTimeline about={{ entityType: 'deal', entityId: record.id, label: record.reference }} canLog={false} />
    ) : tab === 'history' ? (
      history
    ) : (
      <>
        {nextStep}
        {narrow ? milestones : null}
        <Panel title={t('dealFacts')} actions={canEdit ? <Button size="small" onPress={() => setDialog({ kind: 'edit' })}>{t('edit')}</Button> : undefined}>
          <Facts
            items={[
              { label: t('expectedValue'), value: <MoneyText money={record.expectedValue} /> },
              { label: t('probability'), value: <span className="ep-num">{record.probabilityOverride === null ? t('probabilityStage', { value: record.probability }) : t('probabilityOverride', { value: record.probability })}</span> },
              { label: t('weighted'), value: <MoneyText money={record.weightedValue} /> },
              record.expectedFee ? { label: t('expectedFee'), value: <MoneyText money={record.expectedFee} /> } : null,
              { label: t('expectedClose'), value: record.expectedCloseDate ? format.date(record.expectedCloseDate) : '—' },
              record.lead ? { label: t('fromLead'), value: <NextLink href={`/leads/${record.lead.id}`}><Ltr>{record.lead.name}</Ltr></NextLink> } : null,
              { label: t('created'), value: <When iso={record.createdAt} /> },
            ]}
          />
        </Panel>
      </>
    );

  const aside = (
    <>
      <Panel title={t('identityTitle')}>
        <p>{record.identity.required ? t('identityRequired') : t('identityNotRequired')}</p>
        <ul className={styles.list}>
          {record.parties
            .filter((party) => party.partyRole === 'buyer' || party.partyRole === 'tenant')
            .map((party) => (
              <li key={`${party.contact.id}-${party.partyRole}`}>
                <NextLink href={`/contacts/${party.contact.id}/identity`}>
                  <bdi dir="auto">{party.contact.name}</bdi>
                </NextLink>
                <span>
                  {party.identityVerified === null ? (
                    <span className={styles.meta}>{t('identityHidden')}</span>
                  ) : party.identityVerified ? (
                    <>
                      <span aria-hidden="true">✓ </span>
                      {t('verified')}
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true">✕ </span>
                      {t('notVerified')}
                    </>
                  )}
                </span>
              </li>
            ))}
        </ul>
      </Panel>
      <Panel title={t('partiesTitle')} actions={open && access.canEdit ? <Button size="small" onPress={() => setDialog({ kind: 'party' })}>{t('addParty')}</Button> : undefined}>
        <ul className={styles.list}>
          {record.parties.map((party) => (
            <li key={`${party.contact.id}-${party.partyRole}`}>
              <span className={styles.itemMain}>
                <NextLink href={`/contacts/${party.contact.id}`}>
                  <bdi dir="auto">{party.contact.name}</bdi>
                </NextLink>
                <span className={styles.meta}>
                  {t(`partyRoleName.${party.partyRole}`)}
                  {party.isPrimary ? ` · ${t('primary')}` : ''}
                </span>
              </span>
              {party.isPrimary && phone ? (
                <a className={buttonClass('secondary', 'small')} href={telHref(phone)} aria-label={t('callNamed', { name: party.contact.name })}>
                  <span aria-hidden="true">☎ </span>
                  {t('call')}
                </a>
              ) : null}
              {open && access.canEdit && !party.isPrimary ? (
                <Button size="small" variant="quiet" onPress={() => setDialog({ kind: 'removeParty', party })} aria-label={t('removePartyNamed', { name: party.contact.name })}>
                  {t('remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
      {narrow ? null : (
        <Panel title={t('agentsTitleShort')} actions={open && access.canReassign ? <Button size="small" onPress={() => setDialog({ kind: 'agents' })}>{t('edit')}</Button> : undefined}>
          {record.agents.length === 0 ? (
            <p>{t('noAgents')}</p>
          ) : (
            <ul className={styles.list}>
              {record.agents.map((agent) => (
                <li key={agent.member.id}>
                  <bdi>{agent.member.name}</bdi>
                  <span className="ep-num">
                    {t('agentSplit', { split: format.number(agent.splitPercent, { maximumFractionDigits: 4 }), role: t(`agentRoleName.${agent.agentRole}`) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </>
  );

  return (
    <Page>
      <PageHeader
        back={{ href: '/deals', label: t('backToDeals') }}
        title={
          <>
            <Ltr>{record.reference}</Ltr> · <bdi dir="auto">{record.primaryContact.name}</bdi>
          </>
        }
        subtitle={
          <>
            <span>{t(`dealTypeName.${record.dealType}`)}</span>
            {record.listing ? (
              <>
                <span aria-hidden="true">·</span>
                <NextLink href={`/listings/${record.listing.id}`}>
                  <Ltr>{record.listing.reference}</Ltr> <bdi dir="auto">{record.listing.title}</bdi>
                </NextLink>
              </>
            ) : null}
            {record.status !== 'open' ? <DealStatusLabel status={record.status} /> : null}
            {record.stalled && record.status === 'open' ? <StalledLabel since={record.stageEnteredAt} /> : null}
          </>
        }
        actions={<ActionsMenu label={t('dealActions', { reference: record.reference })} actions={menu}>{t('actions')}</ActionsMenu>}
      />
      <nav aria-label={t('stagePath')}>
        <ol className={styles.path}>
          {classes.map((stageClass, index) => (
            <li key={stageClass} aria-current={index === currentIndex ? 'step' : undefined} data-state={index < currentIndex ? 'done' : undefined}>
              {index === currentIndex ? <bdi dir="auto">{record.stage.name}</bdi> : t(`stageClass.${stageClass as 'lead'}`)}
              {index < currentIndex ? <span className="ep-visually-hidden"> ({t('stepDone')})</span> : null}
            </li>
          ))}
        </ol>
      </nav>
      <p className={styles.meta}>
        {t('inStageSince', { date: format.date(record.stageEnteredAt) })} · {t('ownerNamed', { name: record.owner.name })} · <bdi>{record.office.name}</bdi> · <MoneyText money={record.expectedValue} /> ({t('percent', { value: record.probability })})
      </p>
      <nav aria-label={t('recordTabs')} className={styles.tabs}>
        {TABS.filter((id) => !narrow || id === 'overview' || id === 'milestones' || id === 'timeline').map((id) => (
          <NextLink key={id} href={tabHref(id)} aria-current={tab === id ? 'page' : undefined} className={styles.tabLink} scroll={false}>
            {id === 'milestones' && record.milestones.length > 0 ? t('tabMilestonesCount', { count: record.milestones.length }) : t(`tab.${id}`)}
          </NextLink>
        ))}
      </nav>
      {tab === 'overview' ? <RecordLayout asideLabel={t('dealAside')} main={main} aside={aside} /> : main}
      {dialog?.kind === 'edit' ? <EditDealDialog deal={record} onClose={close} /> : null}
      {dialog?.kind === 'move' ? <MoveStageDialog deal={record} onClose={close} /> : null}
      {dialog?.kind === 'reassign' ? <ReassignDialog deal={record} onClose={close} /> : null}
      {dialog?.kind === 'agents' ? <AgentsDialog deal={record} onClose={close} /> : null}
      {dialog?.kind === 'party' ? <AddPartyDialog deal={record} onClose={close} /> : null}
      {dialog?.kind === 'removeParty' ? <RemovePartyDialog deal={record} party={dialog.party} onClose={close} /> : null}
      {dialog?.kind === 'milestoneDone' ? <CompleteMilestoneDialog deal={record} milestone={dialog.milestone} onClose={close} /> : null}
      {dialog?.kind === 'milestoneEdit' ? <EditMilestoneDialog deal={record} milestone={dialog.milestone} onClose={close} /> : null}
      {dialog?.kind === 'exchange' ? <ExchangeDialog deal={record} onClose={close} /> : null}
      {dialog?.kind === 'complete' ? <CompleteDialog deal={record} onClose={close} /> : null}
      {dialog?.kind === 'lose' ? <LoseDialog deal={record} onClose={close} /> : null}
    </Page>
  );
}
