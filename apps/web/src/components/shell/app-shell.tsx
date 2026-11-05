'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { Button as AriaButton, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';

import { useSession } from '@/components/session';
import { buttonClass } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import fieldStyles from '@/components/ui/field.module.css';
import { bff, bffRequest } from '@/lib/bff';

import styles from './app-shell.module.css';
import { buildNavigation, buildQuickCreate, hasCrm, isCurrent, type NavItem } from './navigation';
import { GlobalSearch } from './search';

const ICONS: Record<string, string> = {
  'my-day': '☀',
  'admin-dashboard': '▤',
  'crm-dashboard': '▥',
  dashboard: '▦',
  contacts: '☺',
  'contacts-buyer': '›',
  'contacts-seller': '›',
  'contacts-landlord': '›',
  'contacts-tenant': '›',
  requirements: '⌕',
  'identity-checks': '✓',
  exports: '⇩',
  leads: '✉',
  'follow-ups': '✓',
  properties: '⌂',
  listings: '☰',
  map: '⌖',
  keys: '⚿',
  'property-types': '◇',
  'listing-rules': '⚙',
  'crm-settings': '⚙',
  storage: '◔',
};

/** Badge text for a queue count: hidden at zero, capped so a long queue does not widen the menu. */
function badgeText(count: number, capped: boolean): string {
  return capped ? '99+' : String(count);
}

export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const search = useSearchParams();
  const { session, grant, readOnly } = useSession();
  const sections = buildNavigation(grant);
  const quickCreate = buildQuickCreate(grant);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // "/" and Ctrl/Cmd+K open search, outside text fields (Phase 3 07 §8, WCAG 2.1.4).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const overdue = useQuery({
    queryKey: ['keys', 'mine-overdue', session.membershipId],
    queryFn: () => bff<{ data: unknown[] }>(`key-sets?filter[overdue]=true&filter[holderMembershipId]=${session.membershipId}&limit=100`),
    enabled: grant('key.view') !== undefined,
    staleTime: 60_000,
  });
  const overdueCount = overdue.data?.data.length ?? 0;

  // Queue counts (SH-1): only queues that need action, never totals; a failed fetch hides the badge.
  const canAssignLeads = grant('lead.assign') !== undefined;
  const newLeads = useQuery({
    queryKey: ['shell', 'lead-queue', session.membershipId, canAssignLeads],
    queryFn: () => bff<{ data: unknown[] }>(`leads?filter[status]=new&filter[assignedTo]=${canAssignLeads ? 'unassigned' : 'me'}&limit=100`),
    enabled: grant('lead.view') !== undefined,
    staleTime: 60_000,
  });
  const overdueFollowUps = useQuery({
    queryKey: ['shell', 'follow-ups-overdue', session.membershipId],
    queryFn: () => bff<{ data: unknown[]; page: { nextCursor: string | null } }>('tasks?filter[view]=mine&filter[status]=open&filter[overdue]=true&limit=100'),
    enabled: hasCrm(grant),
    staleTime: 60_000,
  });
  const badges: Record<string, { text: string; label: string } | null> = {
    leads:
      newLeads.data && newLeads.data.data.length > 0
        ? { text: badgeText(newLeads.data.data.length, newLeads.data.data.length >= 100), label: t(canAssignLeads ? 'leadsUnassigned' : 'leadsNewMine', { count: newLeads.data.data.length }) }
        : null,
    'follow-ups':
      overdueFollowUps.data && overdueFollowUps.data.data.length > 0
        ? { text: badgeText(overdueFollowUps.data.data.length, overdueFollowUps.data.page.nextCursor !== null), label: t('followUpsOverdue', { count: overdueFollowUps.data.data.length }) }
        : null,
    keys: overdueCount > 0 ? { text: String(overdueCount), label: t('keysOverdue', { count: overdueCount }) } : null,
  };

  const signOut = async () => {
    const result = await bffRequest<{ redirectTo: string }>('../auth/logout', { method: 'POST' }).catch(() => null);
    window.location.assign(result?.data.redirectTo ?? '/sign-in?signedOut=1');
  };

  const navList = (
    <>
      {sections.map((section) => (
        <div key={section.id}>
          <p className={styles.sectionLabel}>{t(section.label)}</p>
          <ul className={styles.navList}>
            {section.items.map((item) => (
              <li key={item.id}>
                <NextLink href={item.href} className={styles.navLink} aria-current={isCurrent(item, pathname, search) ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
                  <span>
                    <span className={styles.navIcon} aria-hidden="true">
                      {ICONS[item.id]}
                    </span>
                    <span className={styles.navText}>{t(item.label)}</span>
                  </span>
                  {badges[item.id] ? (
                    <span className={styles.badge} aria-label={badges[item.id]!.label}>
                      {badges[item.id]!.text}
                    </span>
                  ) : null}
                </NextLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );

  return (
    <div className={styles.shell}>
      <a className="ep-skip-link" href="#main">
        {t('skipToContent')}
      </a>
      <header className={styles.topbar}>
        <NextLink href="/" className={styles.brand}>
          EstatePro
        </NextLink>
        <div className={styles.company}>
          <span className={styles.companyName}>{session.company.name}</span>
          <NextLink href="/select-company">{t('switchCompany')}</NextLink>
        </div>
        <span className={styles.spacer} />
        <AriaButton className={`${buttonClass('secondary')} ${styles.searchButton}`} onPress={() => setSearchOpen(true)} aria-keyshortcuts="/ Control+K">
          <span aria-hidden="true">⌕</span>
          <span className={styles.searchLabel}>{t('search')}</span>
          <span className="ep-visually-hidden">{t('search')}</span>
        </AriaButton>
        {quickCreate.length > 0 && !readOnly ? (
          <MenuTrigger>
            <AriaButton className={buttonClass('primary')}>{t('create')}</AriaButton>
            <Popover className={fieldStyles.popover} placement="bottom end">
              <Menu aria-label={t('create')}>
                {quickCreate.map((item) => (
                  <MenuItem key={item.id} id={item.id} href={item.href} className={fieldStyles.option}>
                    {t(item.label)}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </MenuTrigger>
        ) : null}
        <MenuTrigger>
          <AriaButton className={buttonClass('quiet')} aria-label={t('account', { name: session.user.displayName })}>
            <span aria-hidden="true">◉</span>
          </AriaButton>
          <Popover className={fieldStyles.popover} placement="bottom end">
            <Menu aria-label={t('account', { name: session.user.displayName })} onAction={(key) => (key === 'sign-out' ? void signOut() : undefined)}>
              <MenuItem id="who" className={fieldStyles.option} isDisabled textValue={session.user.displayName}>
                <strong>{session.user.displayName}</strong>
                <br />
                {session.roleName}
              </MenuItem>
              <MenuItem id="switch" href="/select-company" className={fieldStyles.option}>
                {t('switchCompany')}
              </MenuItem>
              <MenuItem id="sign-out" className={fieldStyles.option}>
                {t('signOut')}
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      </header>
      <nav className={styles.sidebar} aria-label={t('main')}>
        {navList}
      </nav>
      <main id="main" className={styles.main} tabIndex={-1}>
        {readOnly ? (
          <p className={styles.banner} role="status">
            {t('readOnly')}
          </p>
        ) : null}
        {children}
      </main>
      <nav className={styles.bottomBar} aria-label={t('mobile')}>
        {bottomItems(sections.flatMap((section) => section.items)).map((item) => (
            <NextLink key={item.id} href={item.href} aria-current={isCurrent(item, pathname, search) ? 'page' : undefined}>
              <span aria-hidden="true">{ICONS[item.id]}</span>
              {t(item.label)}
            </NextLink>
          ))}
        <button type="button" onClick={() => setMenuOpen(true)} aria-haspopup="dialog">
          <span aria-hidden="true">☰</span>
          {t('menu')}
        </button>
      </nav>
      <Dialog isOpen={menuOpen} onOpenChange={setMenuOpen} title={t('menu')} drawer>
        <nav aria-label={t('main')}>{navList}</nav>
      </Dialog>
      <GlobalSearch isOpen={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

/**
 * Mobile bottom bar (wireframes §8): CRM staff get My day or the CRM
 * dashboard, Leads and Contacts; everyone else keeps the property items.
 */
function bottomItems(items: NavItem[]): NavItem[] {
  const crm = ['my-day', 'crm-dashboard', 'leads', 'contacts', 'follow-ups'];
  const chosen = items.filter((item) => crm.includes(item.id));
  // My day replaces the CRM dashboard for agents; managers keep the dashboard.
  const withoutDuplicateHome = chosen.some((item) => item.id === 'my-day') ? chosen.filter((item) => item.id !== 'crm-dashboard') : chosen;
  if (withoutDuplicateHome.length >= 3) return withoutDuplicateHome.slice(0, 4);
  return items.filter((item) => ['properties', 'listings', 'map', 'keys'].includes(item.id));
}
