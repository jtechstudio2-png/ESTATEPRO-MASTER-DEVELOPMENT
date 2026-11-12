'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useCrmSettings } from '@/components/crm/use-crm';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Checkbox, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { formClass, Page, PageHeader, Panel } from '@/components/ui/layout';
import { bff } from '@/lib/bff';
import { useRefreshAll } from '@/lib/mutations';

/**
 * CRM settings: the company's lead response target (decision D3, gap G1).
 * There is no default: until a company sets one, screens say "not set"
 * instead of judging leads against an assumed target.
 */
export function CrmSettings() {
  const t = useTranslations('crmSettings');
  const { can, readOnly } = useSession();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const settings = useCrmSettings();
  const [enabled, setEnabled] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const minutesId = useId();
  useEffect(() => {
    if (settings.data) {
      setEnabled(settings.data.leadResponseMinutes !== null);
      setMinutes(settings.data.leadResponseMinutes?.toString() ?? '');
    }
  }, [settings.data]);
  const editable = can('settings.manage') && !readOnly;

  const submit = async () => {
    const value = enabled ? Number(minutes) : null;
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 10080)) {
      setClientError(t('minutesInvalid'));
      return;
    }
    setClientError(null);
    setBusy(true);
    setError(null);
    try {
      await bff('settings/crm', { method: 'PUT', body: { leadResponseMinutes: value } });
      announce(value === null ? t('cleared') : t('saved', { minutes: value }));
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader title={t('title')} />
      {settings.isPending ? (
        <Skeleton />
      ) : settings.isError ? (
        <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <Panel title={t('responseTitle')}>
          <form
            className={formClass}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p>{t('responseHelp')}</p>
            <FormProblem error={error} clientErrors={clientError ? { leadResponseMinutes: clientError } : {}} fields={{ leadResponseMinutes: { label: t('minutes'), id: minutesId } }} />
            <Checkbox isSelected={enabled} onChange={setEnabled} isDisabled={!editable}>
              {t('enable')}
            </Checkbox>
            {enabled ? (
              <TextField
                id={minutesId}
                label={t('minutes')}
                description={t('minutesHelp')}
                type="number"
                inputMode="numeric"
                min="1"
                max="10080"
                value={minutes}
                onChange={setMinutes}
                isDisabled={!editable}
                isRequired
                error={clientError ?? fieldErrorsOf(error)['leadResponseMinutes']}
              />
            ) : (
              <Notice tone="info">{t('notSet')}</Notice>
            )}
            {editable ? (
              <div>
                <Button type="submit" variant="primary" busy={busy}>
                  {t('save')}
                </Button>
              </div>
            ) : (
              <p>{t('readOnly')}</p>
            )}
          </form>
        </Panel>
      )}
    </Page>
  );
}
