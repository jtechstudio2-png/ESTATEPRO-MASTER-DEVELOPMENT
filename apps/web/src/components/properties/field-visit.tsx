'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { keyWhere, useKeyDialogState } from '@/components/keys/key-dialogs';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Checkbox, SelectField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Cluster, Page, PageHeader, Panel } from '@/components/ui/layout';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-guard';
import type { KeySetPageDto, PropertyDto, UnitPageDto } from '@/lib/api-schema';
import { bff, bffRequest, newIdempotencyKey, query } from '@/lib/bff';
import { useListParams } from '@/lib/hooks/list-params';
import { useRefreshAll } from '@/lib/mutations';

import styles from './properties.module.css';
import { useProperty } from './use-property';

const WHOLE = '__whole__';
const STEPS = ['access', 'photos', 'feedback', 'keys'] as const;

/**
 * Hands the coordinates to the device's own maps app, only when tapped (X-1).
 * The universal maps URL opens the installed app on phones and the website elsewhere.
 */
export function directionsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${latitude}%2C${longitude}`;
}

/** A small viewport around the property for the property map (M-3). */
function mapHref(latitude: number, longitude: number): string {
  const d = 0.01;
  return `/map/properties?filter[bbox]=${[longitude - d, latitude - d, longitude + d, latitude + d].map((value) => Math.round(value * 1e5) / 1e5).join(',')}`;
}

/** X-1 field actions on the property overview: reach it, add photos and notes, keys, start a visit. */
export function FieldActions({ property }: { property: PropertyDto }) {
  const t = useTranslations('properties.field');
  const { can, readOnly } = useSession();
  const live = property.archivedAt === null && !readOnly;
  const base = `/properties/${property.id}`;
  const { latitude, longitude } = property.address;
  const located = latitude !== null && longitude !== null;
  return (
    <nav aria-label={t('label')} className={styles.fieldActions}>
      {located ? (
        <>
          <LinkButton href={directionsUrl(latitude, longitude)} target="_blank" rel="noopener noreferrer">
            {t('directions')}
            <span className="ep-visually-hidden"> {t('opensMapsApp')}</span>
          </LinkButton>
          <LinkButton href={mapHref(latitude, longitude)}>{t('map')}</LinkButton>
        </>
      ) : null}
      {live && can('property.update') ? <LinkButton href={`${base}/media?upload=photos`}>{t('addPhotos')}</LinkButton> : null}
      {live && can('property_note.create') ? <LinkButton href={`${base}/notes?compose=1`}>{t('addNote')}</LinkButton> : null}
      {can('key.view') ? <LinkButton href={`${base}/keys`}>{t('keys')}</LinkButton> : null}
      {live && can('property_note.create') ? (
        <LinkButton href={`${base}/visit`} variant="primary">
          {t('startVisit')}
        </LinkButton>
      ) : null}
    </nav>
  );
}

/**
 * T-1 field visit: the Phase 4 steps of a site visit in one place. The
 * checklist is a guide kept on this page only (viewings arrive in Phase 6);
 * "Save visit" saves the visit notes as a Viewing note.
 */
export function FieldVisit({ propertyId }: { propertyId: string }) {
  const t = useTranslations('properties.field');
  const common = useTranslations('common');
  const keys = useTranslations('keys');
  const router = useRouter();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const params = useListParams();
  const { session, can, readOnly } = useSession();
  const property = useProperty(propertyId);
  const dialogs = useKeyDialogState();
  const [unitId, setUnitId] = useState(params.get('unit') ?? WHOLE);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [body, setBody] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const bodyId = useId();
  const units = useQuery({ queryKey: ['record', 'units-for-select', propertyId], queryFn: () => bff<UnitPageDto>(`properties/${propertyId}/units?limit=100`) });
  const myKeys = useQuery({
    queryKey: ['record', 'visit-keys', propertyId, session.membershipId],
    queryFn: () => bff<KeySetPageDto>(`properties/${propertyId}/key-sets${query({ 'filter[holderMembershipId]': session.membershipId, 'filter[status]': 'checked_out' })}`),
    enabled: can('key.view'),
  });

  if (property.isPending) return <Skeleton />;
  if (property.isError) return <ErrorNotice error={property.error} onRetry={() => void property.refetch()} />;
  const record = property.data;
  const name = record.name ?? record.reference;
  const base = `/properties/${propertyId}`;
  const canNote = can('property_note.create') && !readOnly && record.archivedAt === null;
  const toggle = (step: string, value: boolean) => {
    const next = new Set(done);
    if (value) next.add(step);
    else next.delete(step);
    setDone(next);
  };

  const save = async () => {
    if (body.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`properties/${propertyId}/notes`, {
        method: 'POST',
        idempotencyKey,
        body: { body: body.trimEnd(), category: 'viewing', visibility: 'internal', isPinned: false, ...(unitId === WHOLE ? {} : { unitId }) },
      });
      announce(t('saved'));
      setBody('');
      await refresh();
      router.push(`${base}/notes?filter[category]=viewing`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const unitLabel = units.data?.data.find((unit) => unit.id === unitId)?.unitLabel;
  return (
    <Page>
      <UnsavedChangesGuard dirty={body.trim() !== ''} />
      <PageHeader title={t('visitTitle', { name: unitLabel ? `${name} · ${unitLabel}` : name })} back={{ href: base, label: name }} />
      <FieldActions property={record} />
      <Panel title={t('checklist')}>
        <p className={styles.quiet}>{t('checklistNote')}</p>
        <SelectField
          label={t('unit')}
          value={unitId}
          onChange={setUnitId}
          options={[{ id: WHOLE, label: t('wholeProperty') }, ...(units.data?.data ?? []).filter((unit) => unit.archivedAt === null).map((unit) => ({ id: unit.id, label: unit.unitLabel }))]}
        />
        <ul className={styles.checklist}>
          {STEPS.map((step) => (
            <li key={step}>
              <Checkbox isSelected={done.has(step)} onChange={(value) => toggle(step, value)}>
                {t(`steps.${step}`)}
              </Checkbox>
              {step === 'photos' && can('property.update') && record.archivedAt === null ? (
                <LinkButton size="small" href={`${base}/media?upload=photos`}>
                  {t('addPhotos')}
                </LinkButton>
              ) : null}
              {step === 'feedback' ? <span className={styles.quiet}>{t('feedbackHint')}</span> : null}
            </li>
          ))}
        </ul>
        {can('key.view') ? (
          <section aria-labelledby="visit-keys">
            <h3 id="visit-keys" className={styles.subheading}>
              {t('keysWithYou')}
            </h3>
            {myKeys.isPending ? (
              <Skeleton />
            ) : myKeys.isError ? (
              <ErrorNotice error={myKeys.error} onRetry={() => void myKeys.refetch()} />
            ) : myKeys.data.data.length === 0 ? (
              <EmptyState headingLevel={4} title={t('noKeysWithYou')} />
            ) : (
              <ul className={styles.checklist}>
                {myKeys.data.data.map((keySet) => (
                  <li key={keySet.id}>
                    <span>
                      <bdi className="ep-num">{keySet.label}</bdi> · <bdi>{keyWhere(keySet)}</bdi>
                    </span>
                    {can('key.issue') && !readOnly ? (
                      <Button size="small" onPress={() => dialogs.open(keySet, 'check-in')} aria-label={`${keys('checkIn')} ${keySet.label}`}>
                        {keys('checkIn')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </Panel>
      {canNote ? (
        <Panel title={t('visitNotes')}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <FormProblem error={error} clientErrors={missing ? { body: t('notesRequired') } : {}} fields={{ body: { label: t('visitNotes'), id: bodyId } }} />
            <TextField
              id={bodyId}
              label={t('visitNotes')}
              value={body}
              onChange={(value) => {
                setBody(value);
                setMissing(false);
              }}
              multiline
              maxLength={10_000}
              dir="auto"
              isRequired
              description={t('visitNotesHint')}
              error={missing ? t('notesRequired') : fieldErrorsOf(error)['body']}
            />
            <Notice tone="info">{t('noSecrets')}</Notice>
            <Cluster>
              <Button variant="primary" type="submit" busy={busy}>
                {t('saveVisit')}
              </Button>
              <LinkButton href={base}>{common('cancel')}</LinkButton>
            </Cluster>
          </form>
        </Panel>
      ) : null}
      {dialogs.dialogs}
    </Page>
  );
}
