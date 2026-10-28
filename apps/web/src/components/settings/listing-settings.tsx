'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Checkbox, RadioGroupField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Fieldset, formClass, Page, PageHeader } from '@/components/ui/layout';
import type { ListingSettingsBody, ListingSettingsDto } from '@/lib/api-schema';
import { bff, bffRequest } from '@/lib/bff';
import { useRefreshAll } from '@/lib/mutations';

/** L-10 listing rules: viewable with listing.view, changed with settings.manage (audited by the API). */
export function ListingSettings() {
  const t = useTranslations('listings.settings');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { can, readOnly } = useSession();
  const manage = can('settings.manage') && !readOnly;
  const settings = useQuery({ queryKey: ['settings', 'listings'], queryFn: () => bff<ListingSettingsDto>('settings/listings') });
  const [mode, setMode] = useState<'none' | 'percent'>('none');
  const [percent, setPercent] = useState('');
  const [kyc, setKyc] = useState(false);
  const [minPhotos, setMinPhotos] = useState('');
  const [floorPlan, setFloorPlan] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setMode(settings.data.priceReductionApprovalPercent === null ? 'none' : 'percent');
    setPercent(settings.data.priceReductionApprovalPercent?.toString() ?? '10');
    setKyc(settings.data.requireSellerKyc);
    setMinPhotos(settings.data.minPhotosToPublish?.toString() ?? '');
    setFloorPlan(settings.data.requireFloorPlanToPublish);
  }, [settings.data]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: ListingSettingsBody = {
        priceReductionApprovalPercent: mode === 'none' ? null : Number(percent),
        requireSellerKyc: kyc,
        minPhotosToPublish: minPhotos.trim() === '' ? null : Number(minPhotos),
        requireFloorPlanToPublish: floorPlan,
      };
      await bffRequest('settings/listings', { method: 'PUT', body });
      announce(t('saved'));
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const errors = fieldErrorsOf(error);
  return (
    <Page>
      <PageHeader
        title={t('title')}
        actions={
          manage ? (
            <Button variant="primary" onPress={() => void save()} busy={busy}>
              {common('save')}
            </Button>
          ) : undefined
        }
      />
      {manage ? null : <Notice tone="info">{t('readOnly')}</Notice>}
      {settings.isPending ? (
        <Skeleton />
      ) : settings.isError ? (
        <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <form
          className={formClass}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FormProblem
            error={error}
            fields={{ priceReductionApprovalPercent: { label: t('percent'), id: 'ls-percent' }, minPhotosToPublish: { label: t('minPhotos'), id: 'ls-photos' } }}
          />
          <Fieldset legend={t('reductions')}>
            <RadioGroupField
              label={t('reductions')}
              value={mode}
              onChange={(value) => setMode(value as 'none' | 'percent')}
              isDisabled={!manage}
              options={[
                { id: 'none', label: t('noApproval') },
                { id: 'percent', label: t('approvalAbove') },
              ]}
            />
            {mode === 'percent' ? (
              <TextField id="ls-percent" label={t('percent')} value={percent} onChange={setPercent} inputMode="numeric" isDisabled={!manage} error={errors['priceReductionApprovalPercent']} />
            ) : null}
          </Fieldset>
          <Checkbox isSelected={kyc} onChange={setKyc} isDisabled={!manage}>
            {t('kyc')}
          </Checkbox>
          <p>{t('kycNote')}</p>
          <TextField id="ls-photos" label={t('minPhotos')} value={minPhotos} onChange={setMinPhotos} inputMode="numeric" description={t('minPhotosHint')} isDisabled={!manage} error={errors['minPhotosToPublish']} />
          <Checkbox isSelected={floorPlan} onChange={setFloorPlan} isDisabled={!manage}>
            {t('floorPlan')}
          </Checkbox>
        </form>
      )}
    </Page>
  );
}
