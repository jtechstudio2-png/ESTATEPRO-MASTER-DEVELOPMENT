'use client';

import NextLink from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';

import styles from './button.module.css';

import { type ButtonVariant, buttonClass } from './button-class';

export { type ButtonVariant, buttonClass };

interface ButtonProps extends Omit<AriaButtonProps, 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: 'normal' | 'small';
  /** Shows a busy indicator, disables the button and keeps the label (UI checklist §6). */
  busy?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'secondary', size = 'normal', busy = false, isDisabled, children, ...props }: ButtonProps) {
  return (
    <AriaButton {...props} isDisabled={isDisabled === true || busy} aria-busy={busy || undefined} className={buttonClass(variant, size)}>
      {busy ? <span className={styles.busy} aria-hidden="true" /> : null}
      {children}
    </AriaButton>
  );
}

/** A real link that looks like a button (navigation, so middle-click and new tabs work). */
export function LinkButton({ variant = 'secondary', size = 'normal', ...props }: ComponentProps<typeof NextLink> & { variant?: ButtonVariant; size?: 'normal' | 'small' }) {
  return <NextLink {...props} className={buttonClass(variant, size)} />;
}
