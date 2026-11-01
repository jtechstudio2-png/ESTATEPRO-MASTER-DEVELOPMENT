'use client';

import { createContext, type ReactNode, useContext, useMemo } from 'react';

import type { Grant, SessionContext } from '@/lib/session-types';

interface SessionValue {
  session: SessionContext;
  /** The member's grant for a permission, or undefined (UI checklist §10). */
  grant: (permission: string) => Grant | undefined;
  can: (permission: string) => boolean;
  readOnly: boolean;
}

const Context = createContext<SessionValue | null>(null);

export function SessionProvider({ session, children }: { session: SessionContext; children: ReactNode }) {
  const value = useMemo<SessionValue>(() => {
    const grants = new Map(session.permissions.map((grant) => [grant.key, grant]));
    return {
      session,
      grant: (permission) => grants.get(permission),
      can: (permission) => grants.has(permission),
      readOnly: session.company.status === 'read_only',
    };
  }, [session]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Context);
  if (value === null) throw new Error('useSession outside SessionProvider');
  return value;
}

/** True when the member may attempt a write with this permission (and the company is not read-only). */
export function useCanWrite(permission: string): boolean {
  const { can, readOnly } = useSession();
  return can(permission) && !readOnly;
}
