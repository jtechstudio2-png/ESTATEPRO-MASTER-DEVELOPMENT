'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { Button } from './button';
import styles from './dialog.module.css';
import { TextField } from './fields';

interface DialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** alertdialog for confirmations of consequential actions. */
  role?: 'dialog' | 'alertdialog';
  size?: 'normal' | 'wide';
  /** Side drawer instead of a centred dialog (G-3, N-3, K-6). */
  drawer?: boolean;
  /** Prevents closing by Escape or outside click while a request is running. */
  isDismissable?: boolean;
}

/**
 * Accessible dialog (UI checklist §4): named by its title, focus moved in and
 * trapped, Escape closes, focus returns to the trigger.
 */
export function Dialog({ isOpen, onOpenChange, title, children, footer, role = 'dialog', size = 'normal', drawer = false, isDismissable = true }: DialogProps) {
  const t = useTranslations('common');
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable && role === 'dialog'}
      isKeyboardDismissDisabled={!isDismissable}
      className={`${styles.overlay} ${drawer ? styles.drawerOverlay : ''}`}
    >
      <Modal className={`${styles.modal} ${size === 'wide' ? styles.wide : ''} ${drawer ? styles.drawer : ''}`}>
        <AriaDialog role={role} className={styles.dialog}>
          {({ close }) => (
            <>
              <div className={styles.header}>
                <Heading slot="title">{title}</Heading>
                {role === 'dialog' ? (
                  <Button variant="quiet" size="small" onPress={close} aria-label={t('close')} isDisabled={!isDismissable}>
                    ✕
                  </Button>
                ) : null}
              </div>
              {children}
              {footer ? <div className={styles.footer}>{footer}</div> : null}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One sentence stating the consequence. */
  consequence: ReactNode;
  /** Names the action and the object, e.g. "Archive Osu Court". */
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  danger?: boolean;
  /** Irreversible actions: the user types this word to enable the button. */
  confirmWord?: string;
  children?: ReactNode;
  canConfirm?: boolean;
}

export function ConfirmDialog({ isOpen, onOpenChange, title, consequence, confirmLabel, onConfirm, busy = false, danger = false, confirmWord, children, canConfirm = true }: ConfirmDialogProps) {
  const t = useTranslations('common');
  const [typed, setTyped] = useState('');
  const wordOk = confirmWord === undefined || typed.trim().toUpperCase() === confirmWord.toUpperCase();
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) setTyped('');
        onOpenChange(open);
      }}
      title={title}
      role="alertdialog"
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={() => onOpenChange(false)} isDisabled={busy}>
            {t('cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onPress={onConfirm} busy={busy} isDisabled={!wordOk || !canConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className={styles.consequence}>{consequence}</p>
      {children}
      {confirmWord !== undefined ? (
        <TextField label={t('typeToConfirm', { word: confirmWord })} value={typed} onChange={setTyped} autoComplete="off" />
      ) : null}
    </Dialog>
  );
}
