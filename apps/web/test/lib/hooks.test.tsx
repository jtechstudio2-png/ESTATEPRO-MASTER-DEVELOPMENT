import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnouncerProvider } from '@/components/announcer';
import { SessionProvider } from '@/components/session';
import { useDocumentTitle } from '@/lib/hooks/document-title';
import { useFormat } from '@/lib/hooks/format';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useCountries, useCurrencies, useLocales, useOffices, usePicklist, usePropertyTypes } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import type { SessionContext } from '@/lib/session-types';
import list from '@/messages/en/list.json';

const session: SessionContext = {
  user: { id: 'u1', displayName: 'Kofi Owusu', email: 'kofi@accra.test' },
  company: { id: 'c1', name: 'Accra Homes', status: 'active', baseCurrencyCode: 'GHS', headquartersCountryCode: 'GH' },
  membershipId: 'm1',
  roleKey: 'agent',
  roleName: 'Agent',
  officeIds: ['o1'],
  permissions: [
    { key: 'property.view', scope: 'office', isSensitive: false },
    { key: 'listing.view', scope: 'all', isSensitive: false },
  ],
  locale: 'en-GB',
  textDirection: 'ltr',
  timezone: 'Africa/Accra',
};

const fetchMock = vi.fn<typeof fetch>();
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={{ list }}>
      <QueryClientProvider client={client}>
        <SessionProvider session={session}>
          <AnnouncerProvider>{children}</AnnouncerProvider>
        </SessionProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  client.clear();
});

describe('paged lists', () => {
  it('loads pages with the cursor, joins rows and announces new pages', async () => {
    fetchMock
      .mockImplementationOnce(() => ok({ data: [{ id: 1 }, { id: 2 }], page: { limit: 2, nextCursor: 'c2' } }))
      .mockImplementationOnce(() => ok({ data: [{ id: 3 }], page: { limit: 2, nextCursor: null } }));
    const { result } = renderHook(() => usePagedList<{ id: number }>('key-sets', new URLSearchParams('filter[status]=lost'), { limit: 2 }), { wrapper });
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(fetchMock.mock.calls[0]![0]).toBe('/bff/key-sets?filter%5Bstatus%5D=lost&limit=2');
    expect(result.current.hasNextPage).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows.map((row) => row.id)).toEqual([1, 2, 3]));
    expect(fetchMock.mock.calls[1]![0]).toBe('/bff/key-sets?filter%5Bstatus%5D=lost&limit=2&cursor=c2');
    expect(result.current.hasNextPage).toBe(false);
    await waitFor(() => expect(document.body.textContent).toContain('Loaded 1 more row'));
  });

  it('waits while disabled and polls while the rows ask for it', async () => {
    // Pending on the first read, done on the next: polling then stops.
    fetchMock
      .mockImplementationOnce(() => ok({ data: [{ id: 1, pending: true }], page: { limit: 50, nextCursor: null } }))
      .mockImplementation(() => ok({ data: [{ id: 1, pending: false }], page: { limit: 50, nextCursor: null } }));
    const interval = vi.fn((rows: Array<{ pending: boolean }>) => (rows.some((row) => row.pending) ? 10 : false));
    const { rerender, result } = renderHook(({ enabled }) => usePagedList<{ id: number; pending: boolean }>('media', new URLSearchParams(), { enabled, refetchInterval: interval }), {
      wrapper,
      initialProps: { enabled: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    await waitFor(() => expect(result.current.rows[0]!.pending).toBe(false));
    expect(interval).toHaveBeenLastCalledWith([{ id: 1, pending: false }]);
    expect(interval).toHaveLastReturnedWith(false);
  });
});

describe('reference data', () => {
  it('offers only live offices within the member’s scope', async () => {
    fetchMock.mockImplementation(() =>
      ok({ data: [{ id: 'o1', archivedAt: null }, { id: 'o2', archivedAt: null }, { id: 'o3', archivedAt: '2026-01-01T00:00:00Z' }] }),
    );
    const office = renderHook(() => useOffices('property.view'), { wrapper });
    await waitFor(() => expect(office.result.current.offices.map((item) => item.id)).toEqual(['o1']));
    const all = renderHook(() => useOffices('listing.view'), { wrapper });
    await waitFor(() => expect(all.result.current.offices.map((item) => item.id)).toEqual(['o1', 'o2']));
    const none = renderHook(() => useOffices(), { wrapper });
    await waitFor(() => expect(none.result.current.isSuccess).toBe(true));
  });

  it('requests each reference list from its endpoint', async () => {
    fetchMock.mockImplementation(() => ok({ data: [] }));
    const hooks: Array<() => { isSuccess: boolean }> = [
      () => usePropertyTypes({ appliesTo: 'property', countryCode: 'GH', active: true }),
      () => usePropertyTypes(),
      () => useCountries(),
      () => usePicklist('tenure', 'GH'),
      () => useLocales(),
      () => useCurrencies(),
    ];
    for (const hook of hooks) {
      const { result } = renderHook(() => hook(), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    }
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/bff/property-types?filter%5BappliesTo%5D=property&filter%5BcountryCode%5D=GH&filter%5Bactive%5D=true',
      '/bff/property-types',
      '/bff/reference/countries',
      '/bff/reference/picklists/tenure?countryCode=GH&locale=en-GB',
      '/bff/reference/locales',
      '/bff/reference/currencies',
    ]);
  });
});

describe('formatting, titles and refresh', () => {
  it('formats in the member’s locale and time zone', () => {
    const { result } = renderHook(() => useFormat(), { wrapper });
    const format = result.current;
    expect(format.locale).toBe('en-GB');
    expect(format.money({ amount: '6000', currency: 'GHS' })).toMatch(/6,000\.00/);
    expect(format.number(1234)).toBe('1,234');
    expect(format.date('2026-10-28T23:30:00Z')).toBe('28 Oct 2026');
    expect(format.date('2026-10-28T23:30:00Z', 'Asia/Qatar')).toBe('29 Oct 2026');
    expect(format.dateTime('2026-10-28T23:30:00Z')).toBe('28 Oct 2026, 23:30');
    expect(format.relative(new Date(Date.now() - 120_000).toISOString()).text).toBe('2 minutes ago');
    expect(format.distance(1500)).toBe('1.5 km');
    expect(format.bytes(2048)).toBe('2 kB');
  });

  it('names the page after its record once loaded', () => {
    document.title = 'EstatePro';
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), { initialProps: { title: null as string | null } });
    expect(document.title).toBe('EstatePro');
    rerender({ title: 'Osu Court' });
    expect(document.title).toBe('Osu Court · EstatePro');
  });

  it('marks every cached query stale after a write', async () => {
    client.setQueryData(['record', 'property', 'p1'], { id: 'p1' });
    const { result } = renderHook(() => useRefreshAll(), { wrapper });
    await act(() => result.current());
    expect(client.getQueryState(['record', 'property', 'p1'])!.isInvalidated).toBe(true);
  });

  it('requires the session provider', () => {
    expect(() => renderHook(() => useFormat())).toThrow('useSession outside SessionProvider');
  });
});
