'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Checkbox, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Facts, formClass } from '@/components/ui/layout';
import type { ContactExportBody, ExportDownloadDto, ExportJobDto, LeadExportBody } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';

const PURPOSE_MIN = 5;
const PURPOSE_MAX = 300;

type ExportRequest = { kind: 'contacts'; filters: Omit<ContactExportBody, 'purpose'> } | { kind: 'leads'; filters: Omit<LeadExportBody, 'purpose'> };

/**
 * Starts the browser download of a finished export (CA-16): the API returns a
 * signed link valid for five minutes; only the person who asked may get one
 * (C4-D3). The link is used at once and never stored.
 */
export async function downloadExport(id: string): Promise<void> {
  const link = await bff<ExportDownloadDto>(`exports/${id}/download`, { method: 'POST' });
  window.location.assign(link.url);
}

/**
 * Export dialog for contacts and leads (C-1, L-1; decisions C4-D2 to C4-D4):
 * the user states why, sees what the file will and will not contain, and the
 * export is audited with that purpose. The filters are the list's own.
 */
export function ExportDialog({ request, summary, onClose }: { request: ExportRequest; summary: string[]; onClose: () => void }) {
  const t = useTranslations('exports');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const format = useFormat();
  const purposeId = useId();
  const [purpose, setPurpose] = useState('');
  const [excludeWithdrawn, setExcludeWithdrawn] = useState(request.kind === 'contacts' ? (request.filters.excludeMarketingWithdrawn ?? false) : false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<ExportJobDto | null>(null);

  const submit = async () => {
    const trimmed = purpose.trim();
    if (trimmed.length < PURPOSE_MIN) {
      setClientError(t('purposeTooShort', { min: PURPOSE_MIN }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = request.kind === 'contacts' ? { ...request.filters, excludeMarketingWithdrawn: excludeWithdrawn, purpose: trimmed } : { ...request.filters, purpose: trimmed };
      const created = await bff<ExportJobDto>(`${request.kind}/exports`, { method: 'POST', body });
      setJob(created);
      announce(created.status === 'completed' ? t('ready', { count: created.rowCount ?? 0 }) : t('failedTitle'));
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      await downloadExport(job.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={request.kind === 'contacts' ? t('contactsTitle') : t('leadsTitle')}
      isDismissable={!busy}
      footer={
        job === null ? (
          <>
            <Button onPress={onClose} isDisabled={busy}>
              {common('cancel')}
            </Button>
            <Button variant="primary" onPress={() => void submit()} busy={busy}>
              {t('create')}
            </Button>
          </>
        ) : (
          <>
            <Button onPress={onClose} isDisabled={busy}>
              {common('close')}
            </Button>
            {job.status === 'completed' && job.canDownload ? (
              <Button variant="primary" onPress={() => void download()} busy={busy}>
                {t('download')}
              </Button>
            ) : null}
          </>
        )
      }
    >
      {job === null ? (
        <div className={formClass}>
          <FormProblem error={error} clientErrors={clientError ? { purpose: clientError } : {}} fields={{ purpose: { label: t('purpose'), id: purposeId } }} />
          <section aria-label={t('whatIsIncluded')}>
            <p>
              <strong>{t('filtersHeading')}</strong> {summary.length > 0 ? summary.join(' · ') : t('noFilters')}
            </p>
            <p>{request.kind === 'contacts' ? t('contactsIncluded') : t('leadsIncluded')}</p>
            <p>{t('neverIncluded')}</p>
          </section>
          <TextField
            id={purposeId}
            label={t('purpose')}
            description={t('purposeHelp', { max: PURPOSE_MAX })}
            value={purpose}
            onChange={(value) => {
              setPurpose(value);
              setClientError(null);
            }}
            isRequired
            multiline
            maxLength={PURPOSE_MAX}
            dir="auto"
            error={clientError ?? fieldErrorsOf(error)['purpose']}
          />
          {request.kind === 'contacts' ? (
            <Checkbox isSelected={excludeWithdrawn} onChange={setExcludeWithdrawn}>
              {t('excludeWithdrawn')}
            </Checkbox>
          ) : null}
          <Notice tone="info">{t('governance')}</Notice>
        </div>
      ) : job.status === 'completed' ? (
        <div className={formClass}>
          <Notice tone="success" title={t('ready', { count: job.rowCount ?? 0 })}>
            {job.expiresAt ? t('expiresAt', { when: format.dateTime(job.expiresAt) }) : null}
          </Notice>
          <Facts
            items={[
              { label: t('file'), value: job.fileName ? <bdi dir="ltr">{job.fileName}</bdi> : '—' },
              { label: t('rows'), value: <span className="ep-num">{format.number(job.rowCount ?? 0)}</span> },
            ]}
          />
          {error ? <FormProblem error={error} fields={{}} /> : null}
          <p>{t('downloadHelp')}</p>
        </div>
      ) : (
        <Notice tone="danger" title={t('failedTitle')}>
          {t('failedDetail')}
        </Notice>
      )}
    </Dialog>
  );
}
