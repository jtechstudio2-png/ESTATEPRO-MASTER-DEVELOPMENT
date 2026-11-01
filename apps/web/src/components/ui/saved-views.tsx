'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button as AriaButton, Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components';

import { useSession } from '@/components/session';
import { useListParams } from '@/lib/hooks/list-params';

import { Button } from './button';
import { buttonClass } from './button-class';
import { Dialog } from './dialog';
import fieldStyles from './field.module.css';
import { TextField } from './fields';

interface SavedView {
  name: string;
  query: string;
}

const PREFIX = 'ep:views:';

/**
 * Saved list views (P-1 "Views"): named URL queries kept in this browser for
 * this member of this company — a per-user convenience, never shared state.
 */
export function SavedViews({ list, label }: { list: string; label: string }) {
  const t = useTranslations('properties');
  const common = useTranslations('common');
  const { session } = useSession();
  const params = useListParams();
  const key = `${PREFIX}${session.membershipId}:${list}`;
  const [views, setViews] = useState<SavedView[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown;
      setViews(Array.isArray(stored) ? (stored as SavedView[]) : []);
    } catch {
      setViews([]);
    }
  }, [key]);

  const persist = (next: SavedView[]) => {
    setViews(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Storage unavailable: views last for this page only.
    }
  };

  const current = params.apiQuery.toString();
  return (
    <>
      <MenuTrigger>
        <AriaButton className={buttonClass('secondary')}>
          {label} <span aria-hidden="true">▾</span>
        </AriaButton>
        <Popover className={fieldStyles.popover} placement="bottom end">
          <Menu
            aria-label={label}
            onAction={(id) => {
              const action = String(id);
              if (action === 'save') {
                setName('');
                setNaming(true);
              } else if (action.startsWith('apply:')) {
                const view = views[Number(action.slice(6))];
                if (view) params.replaceAll(view.query);
              } else if (action.startsWith('delete:')) {
                persist(views.filter((_, index) => index !== Number(action.slice(7))));
              }
            }}
          >
            {views.length === 0 ? (
              <MenuItem id="none" isDisabled className={fieldStyles.option}>
                {t('noViews')}
              </MenuItem>
            ) : null}
            {views.map((view, index) => (
              <MenuItem key={`apply-${view.name}`} id={`apply:${index}`} className={fieldStyles.option} textValue={view.name}>
                <bdi>{view.name}</bdi>
                {view.query === current ? ' ✓' : ''}
              </MenuItem>
            ))}
            <Separator />
            <MenuItem id="save" className={fieldStyles.option}>
              {t('saveView')}
            </MenuItem>
            {views.map((view, index) => (
              <MenuItem key={`delete-${view.name}`} id={`delete:${index}`} className={fieldStyles.option}>
                {t('deleteView', { name: view.name })}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
      <Dialog
        isOpen={naming}
        onOpenChange={setNaming}
        title={t('saveView')}
        footer={
          <>
            <Button onPress={() => setNaming(false)}>{common('cancel')}</Button>
            <Button
              variant="primary"
              isDisabled={name.trim() === ''}
              onPress={() => {
                persist([...views.filter((view) => view.name !== name.trim()), { name: name.trim(), query: current }]);
                setNaming(false);
              }}
            >
              {t('saveView')}
            </Button>
          </>
        }
      >
        <TextField label={t('viewName')} value={name} onChange={setName} maxLength={60} autoFocus />
      </Dialog>
    </>
  );
}
