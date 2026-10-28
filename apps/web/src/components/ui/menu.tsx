'use client';

import type { ReactNode } from 'react';
import { Button as AriaButton, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';

import { buttonClass } from './button';
import fieldStyles from './field.module.css';

export interface MenuAction {
  id: string;
  label: string;
  onAction: () => void;
  isDisabled?: boolean;
  danger?: boolean;
}

/** "More actions for {record}" (UI checklist §1): no hover-only actions. */
export function ActionsMenu({ label, actions, children }: { label: string; actions: MenuAction[]; children?: ReactNode }) {
  if (actions.length === 0) return null;
  return (
    <MenuTrigger>
      <AriaButton className={buttonClass('secondary', 'small')} aria-label={label}>
        {children ?? '⋯'}
      </AriaButton>
      <Popover className={fieldStyles.popover} placement="bottom end">
        <Menu
          aria-label={label}
          disabledKeys={actions.filter((action) => action.isDisabled).map((action) => action.id)}
          onAction={(key) => actions.find((action) => action.id === key)?.onAction()}
        >
          {actions.map((action) => (
            <MenuItem key={action.id} id={action.id} className={fieldStyles.option} style={action.danger ? { color: 'var(--ep-color-danger)' } : undefined}>
              {action.label}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
