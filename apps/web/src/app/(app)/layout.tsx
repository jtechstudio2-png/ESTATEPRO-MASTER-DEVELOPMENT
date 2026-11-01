import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { SessionProvider } from '@/components/session';
import { AppShell } from '@/components/shell/app-shell';
import { pageContext } from '@/server/context';

/** Every staff page needs a session and a chosen company (S-1, S-2). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const context = await pageContext();
  const path = (await headers()).get('x-pathname') ?? '/';
  if (!context.signedIn) redirect(`/sign-in?returnTo=${encodeURIComponent(path)}`);
  if (context.session === null) redirect(`/select-company?returnTo=${encodeURIComponent(path)}`);
  return (
    <SessionProvider session={context.session}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
