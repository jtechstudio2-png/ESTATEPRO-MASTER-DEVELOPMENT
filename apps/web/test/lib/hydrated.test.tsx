import { renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { useHydrated } from '@/lib/hooks/hydrated';

function Probe() {
  return <span>{useHydrated() ? 'ready' : 'waiting'}</span>;
}

describe('useHydrated (S5-R4)', () => {
  it('is false when rendered on the server', () => {
    expect(renderToString(<Probe />)).toContain('waiting');
  });

  it('is true once mounted in the browser', () => {
    const { result } = renderHook(() => useHydrated());
    expect(result.current).toBe(true);
  });
});
