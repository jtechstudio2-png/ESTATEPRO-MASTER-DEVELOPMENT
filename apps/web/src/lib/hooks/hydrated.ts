'use client';

import { useEffect, useState } from 'react';

/**
 * False on the server and during hydration, true once React is attached in
 * the browser. Search fields stay disabled until then (S5-R4): text typed
 * into a server-rendered field before its handlers exist is never searched,
 * so the field does not accept typing until it can act on it. In practice
 * this lasts a fraction of a second after the page appears.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
