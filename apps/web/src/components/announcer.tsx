'use client';

import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';

type Politeness = 'polite' | 'assertive';
const Context = createContext<(message: string, politeness?: Politeness) => void>(() => undefined);

/**
 * One polite and one assertive live region for the whole app (UI checklist
 * §8: status messages without announcing every keystroke). Repeating the same
 * message re-announces it.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const toggle = useRef(false);
  const announce = useCallback((message: string, politeness: Politeness = 'polite') => {
    toggle.current = !toggle.current;
    const text = toggle.current ? message : `${message} `;
    if (politeness === 'assertive') setAssertive(text);
    else setPolite(text);
  }, []);
  return (
    <Context.Provider value={announce}>
      {children}
      <div className="ep-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="ep-visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </Context.Provider>
  );
}

export function useAnnounce() {
  return useContext(Context);
}
