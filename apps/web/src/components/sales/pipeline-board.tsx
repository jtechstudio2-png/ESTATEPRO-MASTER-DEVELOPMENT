'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { type DragEvent, useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { Ltr } from '@/components/crm/labels';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { SegmentedControl, SelectField } from '@/components/ui/fields';
import { Page, PageHeader } from '@/components/ui/layout';
import { LoadMore } from '@/components/ui/list-controls';
import { ActionsMenu } from '@/components/ui/menu';
import type { DealDto, DealSummaryDto, ForecastDto, PipelineColumnDto, PipelineTotalDto } from '@/lib/api-schema';
import { bff, query as queryString } from '@/lib/bff';
import { todayIn } from '@/lib/time';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useOffices } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { NewDealDialog } from './deal-dialogs';
import { MoneyText, StalledLabel } from './sales-labels';
import styles from './sales.module.css';
import { dropOutcome, quarterStart, sumForecast } from './sales-rules';
import { useNarrow, usePipeline } from './use-sales';

const CLOSED = new Set(['closed_won', 'closed_lost']);
const DRAG_TYPE = 'application/x-estatepro-deal';

/** Totals per currency, never converted (S3-D14): one line per currency. */
function Totals({ totals }: { totals: PipelineTotalDto[] }) {
  const t = useTranslations('sales');
  if (totals.length === 0) return null;
  return (
    <dl className={styles.totals}>
      {totals.map((total) => (
        <div key={total.currency}>
          <dt className="ep-visually-hidden">{total.currency}</dt>
          <dd style={{ margin: 0 }}>
            <MoneyText money={total.expectedValue} /> · {t('weightedShort')} <MoneyText money={total.weightedValue} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * PB-1 pipeline board. Every move is possible without dragging (WCAG 2.2
 * 2.5.7): each card has a "Move to" menu; drag and drop is a shortcut (W-D1).
 * Only the stages the API allows are reached by a move; later columns are
 * reached by their actions, which a drop explains. Phones get a stage list
 * with counts instead of the board (W-D4).
 */
export function PipelineBoard() {
  const t = useTranslations('sales');
  const { can, readOnly, grant, session } = useSession();
  const params = useListParams();
  const narrow = useNarrow();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { offices } = useOffices('deal.view');
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const dealType = params.get('dealType') === 'letting' ? 'letting' : 'sale';
  const owner = params.get('owner') === 'me' ? 'me' : null;
  const officeId = params.get('officeId');
  const pipeline = usePipeline(dealType, { officeId, ownerMembershipId: owner });
  const columns = (pipeline.data?.columns ?? []).filter((column) => !CLOSED.has(column.stage.stageClass));
  // Weighted forecast for this quarter (Phase 3 design 06 §5), per currency, never converted.
  const quarter = quarterStart(todayIn(session.timezone));
  const forecast = useQuery({
    queryKey: ['list', 'forecast', 'board', dealType, quarter, officeId, owner],
    queryFn: ({ signal }) => bff<ForecastDto>(`deals/forecast${queryString({ dealType, from: quarter, months: 3, officeId, ownerMembershipId: owner })}`, { signal }),
  });
  const quarterTotals = forecast.data ? sumForecast(forecast.data.months) : [];
  const canMove = can('deal.update') && !readOnly;
  const scope = grant('deal.view')?.scope;

  const say = (tone: 'success' | 'warning' | 'danger', text: string) => {
    setMessage({ tone, text });
    announce(text);
  };

  /** Moves a card to a column after reading the deal's current version and allowed stages. */
  const moveTo = async (summary: DealSummaryDto, target: PipelineColumnDto['stage']) => {
    setMoving(summary.id);
    try {
      const deal = await bff<DealDto>(`deals/${summary.id}`);
      const outcome = dropOutcome(deal.stage.id, target, deal.access.nextStages);
      if (outcome.kind === 'none') return;
      if (outcome.kind === 'action') {
        say('warning', t(`reachBy.${outcome.action as 'accept'}`, { stage: target.name }));
        return;
      }
      if (outcome.kind === 'refused') {
        say('warning', t('moveRefused', { reference: deal.reference, stage: target.name }));
        return;
      }
      await bff(`deals/${deal.id}/stage`, { method: 'POST', version: deal.version, body: { stageId: target.id } });
      say('success', t('movedTo', { reference: deal.reference, stage: target.name }));
      await refresh();
    } catch (caught) {
      say('danger', caught instanceof ApiError ? (caught.problem.detail ?? caught.problem.title) : t('moveFailed'));
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setMoving(null);
    }
  };

  const header = (
    <PageHeader
      title={t('pipelineTitle')}
      actions={
        <>
          <LinkButton href="/deals">{t('listView')}</LinkButton>
          {can('deal.create') && !readOnly ? (
            <Button variant="primary" onPress={() => setCreating(true)}>
              {t('newDeal')}
            </Button>
          ) : null}
        </>
      }
    />
  );

  const controls = (
    <div className={styles.actions} role="group" aria-label={t('boardFilters')}>
      <SegmentedControl label={t('dealType')} value={dealType} onChange={(value) => params.set({ dealType: value === 'sale' ? null : value })} options={(['sale', 'letting'] as const).map((id) => ({ id, label: t(`dealTypeName.${id}`) }))} />
      {scope !== 'own' ? (
        <SegmentedControl label={t('owner')} value={owner ?? 'anyone'} onChange={(value) => params.set({ owner: value === 'me' ? 'me' : null })} options={[{ id: 'anyone', label: t('ownerAnyone') }, { id: 'me', label: t('ownerMe') }]} />
      ) : null}
      {offices.length > 1 ? <SelectField label={t('office')} value={officeId ?? ''} onChange={(value) => params.set({ officeId: value || null })} options={[{ id: '', label: t('allOffices') }, ...offices.map((office) => ({ id: office.id, label: office.name }))]} /> : null}
    </div>
  );

  if (pipeline.isPending) {
    return (
      <Page>
        {header}
        <div aria-busy="true" aria-label={t('pipelineTitle')}>
          <Skeleton />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (pipeline.isError) {
    return (
      <Page>
        {header}
        <ErrorNotice error={pipeline.error} onRetry={() => void pipeline.refetch()} />
      </Page>
    );
  }

  return (
    <Page>
      {header}
      {controls}
      {message ? (
        <Notice tone={message.tone} title={message.text} action={<Button size="small" onPress={() => setMessage(null)}>{t('dismiss')}</Button>} />
      ) : null}
      <RefreshBar active={pipeline.isFetching} />
      {columns.length === 0 ? (
        <EmptyState title={t('noPipeline')}>{t('noPipelineDetail')}</EmptyState>
      ) : narrow ? (
        <section aria-label={t('stageList')}>
          <ul className={styles.list}>
            {columns.map((column) => (
              <li key={column.stage.id}>
                <span className={styles.itemMain}>
                  <NextLink href={`/deals?filter[stageId]=${column.stage.id}&filter[dealType]=${dealType}`}>
                    <bdi dir="auto">{column.stage.name}</bdi>
                  </NextLink>
                  <Totals totals={column.totals} />
                </span>
                <span className={styles.inline}>
                  <span className="ep-num">{t('dealCount', { count: column.count })}</span>
                  {column.stalledCount > 0 ? <span>{t('stalledCount', { count: column.stalledCount })}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        // A labelled, focusable region: the board scrolls sideways and must be reachable by keyboard.
        <div className={styles.board} role="region" aria-label={t('boardRegion')} tabIndex={0}>
          {columns.map((column) => (
            <Column
              key={column.stage.id}
              column={column}
              columns={columns}
              dealType={dealType}
              officeId={officeId}
              owner={owner}
              canMove={canMove}
              moving={moving}
              isDropTarget={dropTarget === column.stage.id}
              onDragTarget={(on) => setDropTarget(on ? column.stage.id : null)}
              onMove={(deal, target) => void moveTo(deal, target)}
            />
          ))}
        </div>
      )}
      {forecast.data ? (
        <p className={styles.meta}>
          {t('quarterForecast')}{' '}
          {quarterTotals.length === 0
            ? t('quarterForecastNone')
            : quarterTotals.map((total, index) => (
                <span key={total.currency}>
                  {index > 0 ? ' · ' : null}
                  <MoneyText money={{ amount: total.weighted, currency: total.currency }} /> ({t('dealCount', { count: total.count })})
                </span>
              ))}{' '}
          <NextLink href={`/forecast${dealType === 'letting' ? '?dealType=letting' : ''}`}>{t('howCalculated')}</NextLink>
        </p>
      ) : null}
      {creating ? <NewDealDialog presetContact={null} onClose={() => setCreating(false)} /> : null}
    </Page>
  );
}

function Column({
  column,
  columns,
  dealType,
  officeId,
  owner,
  canMove,
  moving,
  isDropTarget,
  onDragTarget,
  onMove,
}: {
  column: PipelineColumnDto;
  columns: PipelineColumnDto[];
  dealType: string;
  officeId: string | null;
  owner: string | null;
  canMove: boolean;
  moving: string | null;
  isDropTarget: boolean;
  onDragTarget: (on: boolean) => void;
  onMove: (deal: DealSummaryDto, target: PipelineColumnDto['stage']) => void;
}) {
  const t = useTranslations('sales');
  const headingId = useId();
  const query = new URLSearchParams({ 'filter[stageId]': column.stage.id, 'filter[status]': 'open', 'filter[dealType]': dealType, sort: '-stageEnteredAt' });
  if (officeId) query.set('filter[officeId]', officeId);
  if (owner) query.set('filter[ownerMembershipId]', owner);
  const cards = usePagedList<DealSummaryDto>('deals', query, { limit: 20, enabled: column.count > 0 });

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    onDragTarget(false);
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    const deal = JSON.parse(raw) as DealSummaryDto;
    onMove(deal, column.stage);
  };

  return (
    <section
      className={styles.column}
      aria-labelledby={headingId}
      data-drop-target={isDropTarget ? 'true' : undefined}
      {...(canMove
        ? {
            onDragOver: (event: DragEvent<HTMLElement>) => {
              if (event.dataTransfer.types.includes(DRAG_TYPE)) {
                event.preventDefault();
                onDragTarget(true);
              }
            },
            onDragLeave: () => onDragTarget(false),
            onDrop,
          }
        : {})}
    >
      <h2 className={styles.columnHeading} id={headingId}>
        <bdi dir="auto">{column.stage.name}</bdi>
        <span className="ep-num">{t('dealCount', { count: column.count })}</span>
      </h2>
      <Totals totals={column.totals} />
      {column.stalledCount > 0 ? (
        <p className={styles.meta}>
          <span aria-hidden="true">⚠ </span>
          {t('stalledCount', { count: column.stalledCount })}
        </p>
      ) : null}
      {column.count === 0 ? (
        <p className={styles.meta}>{t('emptyColumn')}</p>
      ) : cards.isPending ? (
        <Skeleton />
      ) : cards.isError ? (
        <ErrorNotice error={cards.error} onRetry={() => void cards.refetch()} />
      ) : (
        <ul className={styles.cards} aria-labelledby={headingId}>
          {cards.rows.map((deal) => (
            <li
              key={deal.id}
              className={styles.card}
              aria-busy={moving === deal.id ? 'true' : undefined}
              {...(canMove
                ? {
                    draggable: true,
                    onDragStart: (event: DragEvent<HTMLLIElement>) => {
                      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(deal));
                      event.dataTransfer.effectAllowed = 'move';
                    },
                  }
                : {})}
            >
              <NextLink href={`/deals/${deal.id}`} className={styles.cardLink}>
                <Ltr>{deal.reference}</Ltr>
              </NextLink>
              <bdi dir="auto">{deal.primaryContact.name}</bdi>
              {deal.listing ? (
                <span className={styles.meta}>
                  <Ltr>{deal.listing.reference}</Ltr>
                </span>
              ) : null}
              <MoneyText money={deal.expectedValue} />
              <span className={styles.inline}>
                <bdi className={styles.meta}>{deal.owner.name}</bdi>
                {deal.stalled ? <StalledLabel since={deal.stageEnteredAt} /> : null}
              </span>
              {canMove ? (
                <ActionsMenu
                  label={t('moveNamed', { reference: deal.reference })}
                  actions={columns
                    .filter((other) => other.stage.id !== column.stage.id)
                    .map((other) => ({ id: other.stage.id, label: other.stage.name, onAction: () => onMove(deal, other.stage) }))}
                >
                  {t('moveTo')}
                </ActionsMenu>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {cards.hasNextPage ? <LoadMore hasMore={cards.hasNextPage} loading={cards.isFetchingNextPage} onLoad={cards.loadMore} shown={cards.rows.length} /> : null}
    </section>
  );
}

