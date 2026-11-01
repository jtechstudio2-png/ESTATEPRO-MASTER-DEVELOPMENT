import styles from './button.module.css';

export type ButtonVariant = 'secondary' | 'primary' | 'danger' | 'quiet';

/** Button styling for links and server-rendered pages (no client code). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: 'normal' | 'small' = 'normal'): string {
  return [styles.button, variant === 'secondary' ? '' : styles[variant], size === 'small' ? styles.small : ''].filter(Boolean).join(' ');
}
