'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { ConfirmDialog } from './dialog';

/**
 * UnsavedChangesGuard (P-3): asks before leaving a form with unsaved changes,
 * both for in-app links and for closing or reloading the tab.
 */
export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const t = useTranslations('common');
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest('a');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.hash)) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(url.pathname + url.search + url.hash);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
    };
  }, [dirty]);

  return (
    <ConfirmDialog
      isOpen={target !== null}
      onOpenChange={(open) => (open ? undefined : setTarget(null))}
      title={t('unsavedTitle')}
      consequence={t('unsavedDetail')}
      confirmLabel={t('unsavedLeave')}
      danger
      onConfirm={() => {
        const href = target;
        setTarget(null);
        if (href) router.push(href);
      }}
    />
  );
}
