'use client';

import { useEffect } from 'react';

/** Names the page after its record once it has loaded (WCAG 2.4.2). */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title) document.title = `${title} · EstatePro`;
  }, [title]);
}
