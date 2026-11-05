import { redirect } from 'next/navigation';

import { landingPath } from '@/components/shell/navigation';
import { pageContext } from '@/server/context';

/**
 * The start page depends on the member's role (SH-1): My day for agents, the
 * admin dashboard for owners and administrators, the CRM dashboard for
 * managers, the property dashboard otherwise. Members not signed in go to
 * sign-in; members without a chosen company choose one and come back here.
 */
export default async function Home() {
  const context = await pageContext();
  if (!context.signedIn) redirect('/sign-in');
  // Choose the company first, then come back here for the role's start page.
  if (context.session === null) redirect('/select-company?returnTo=%2F');
  const grants = new Map(context.session.permissions.map((grant) => [grant.key, grant]));
  redirect(landingPath((permission) => grants.get(permission)));
}
