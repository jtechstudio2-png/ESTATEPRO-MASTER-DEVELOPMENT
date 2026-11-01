import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/keys',
  useSearchParams: () => search,
}));

const { useListParams } = await import('@/lib/hooks/list-params');

beforeEach(() => {
  replace.mockReset();
  search = new URLSearchParams('filter[status]=checked_out&tab=overdue&cursor=abc&holderName=Yaw&pane=list&sort=dueBackAt&filter[tags]=a,b');
});

describe('list state in the URL', () => {
  it('reads values and lists', () => {
    const { result } = renderHook(() => useListParams());
    expect(result.current.get('filter[status]')).toBe('checked_out');
    expect(result.current.getList('filter[tags]')).toEqual(['a', 'b']);
    expect(result.current.getList('missing')).toEqual([]);
  });

  it('forwards only API parameters (no cursor or interface-only state)', () => {
    const { result } = renderHook(() => useListParams());
    expect(result.current.apiQuery.toString()).toBe('filter%5Bstatus%5D=checked_out&sort=dueBackAt&filter%5Btags%5D=a%2Cb');
  });

  it('sets, removes and joins values and starts again from the first page', () => {
    const { result } = renderHook(() => useListParams());
    act(() => result.current.set({ 'filter[status]': null, sort: '', q: 'osu', 'filter[ids]': ['x', 'y'] }));
    expect(replace).toHaveBeenCalledWith('/keys?tab=overdue&holderName=Yaw&pane=list&filter%5Btags%5D=a%2Cb&q=osu&filter%5Bids%5D=x%2Cy', { scroll: false });
  });

  it('clears all but the kept keys, and replaces the whole query', () => {
    const { result } = renderHook(() => useListParams());
    act(() => result.current.clear(['sort', 'absent']));
    expect(replace).toHaveBeenLastCalledWith('/keys?sort=dueBackAt', { scroll: false });
    act(() => result.current.clear());
    expect(replace).toHaveBeenLastCalledWith('/keys', { scroll: false });
    act(() => result.current.replaceAll('q=villa'));
    expect(replace).toHaveBeenLastCalledWith('/keys?q=villa', { scroll: false });
    act(() => result.current.replaceAll(''));
    expect(replace).toHaveBeenLastCalledWith('/keys', { scroll: false });
  });
});
