// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setCsrfToken } from '@/lib/bff';
import { allowedTypes, MAX_IMAGE_BYTES, MAX_PDF_BYTES, maxBytes, precheck, putWithProgress, sha256Hex, uploadFile } from '@/lib/upload';

class FakeXhr {
  static last: FakeXhr | null = null;
  static status = 200;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    this.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
    this.status = FakeXhr.status;
    queueMicrotask(() => this.onload?.());
  }
  abort() {
    this.onabort?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.status = 200;
});

const ticket = { id: 'u1', method: 'PUT' as const, uploadUrl: 'https://storage.test/bucket/key', headers: { 'Content-Type': 'image/png', 'Content-Length': '3', Host: 'x' }, expiresAt: '2026-10-28T12:00:00Z' };

describe('upload rules', () => {
  it('mirrors the API type and size rules', () => {
    expect(allowedTypes('photo')).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(allowedTypes('brochure')).toEqual(['application/pdf']);
    expect(allowedTypes('floor_plan')).toContain('application/pdf');
    expect(maxBytes('application/pdf')).toBe(MAX_PDF_BYTES);
    expect(maxBytes('image/png')).toBe(MAX_IMAGE_BYTES);
    expect(precheck({ type: 'text/plain', size: 10 }, 'photo')).toEqual({ code: 'type' });
    expect(precheck({ type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 }, 'photo')).toEqual({ code: 'size', limit: MAX_IMAGE_BYTES });
    expect(precheck({ type: 'application/pdf', size: 1000 }, 'site_plan')).toBeNull();
  });

  it('hashes files with SHA-256', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('direct upload to storage', () => {
  it('PUTs with the ticket headers (not Host or Content-Length) and reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const progress = vi.fn();
    await putWithProgress(ticket, new Blob(['abc']), progress, new AbortController().signal);
    expect(FakeXhr.last!.method).toBe('PUT');
    expect(FakeXhr.last!.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(progress).toHaveBeenCalledWith(0.5);
  });

  it('rejects on a storage error, a network error and an abort', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.status = 403;
    await expect(putWithProgress(ticket, new Blob(['abc']), () => undefined, new AbortController().signal)).rejects.toThrow('storage-403');
    FakeXhr.status = 200;
    const failing = putWithProgress(ticket, new Blob(['abc']), () => undefined, new AbortController().signal);
    FakeXhr.last!.onload = null;
    FakeXhr.last!.onerror?.();
    await expect(failing).rejects.toThrow('network');
    const controller = new AbortController();
    const aborted = putWithProgress(ticket, new Blob(['abc']), () => undefined, controller.signal);
    FakeXhr.last!.onload = null;
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('requests a ticket, uploads and confirms', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    setCsrfToken('t');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(ticket), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'm1', processingStatus: 'pending' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const stages: string[] = [];
    const file = new File(['abc'], 'front.png', { type: 'image/png' });
    const media = await uploadFile(file, { propertyId: 'p1', mediaType: 'photo', unitId: 'u1', listingId: 'l1' }, { onStage: (stage) => stages.push(stage), onProgress: () => undefined, signal: new AbortController().signal });
    expect(media).toMatchObject({ id: 'm1' });
    expect(stages).toEqual(['hashing', 'uploading', 'confirming']);
    const created = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(created).toMatchObject({ propertyId: 'p1', mediaType: 'photo', fileName: 'front.png', contentType: 'image/png', size: 3, unitId: 'u1', listingId: 'l1' });
    expect(created['sha256']).toHaveLength(64);
    expect(fetchMock.mock.calls[1]![0]).toBe('/bff/media/uploads/u1/confirm');
    setCsrfToken(null);
  });
});
