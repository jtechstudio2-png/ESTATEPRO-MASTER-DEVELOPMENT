import { createServer, type Server, type Socket } from 'node:net';
import { deflateSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { normaliseFileName, storageKeysOf } from '../src/media/media.service.js';
import { allowedMimeTypes, isPlan, maxBytesFor, parseExternalLink } from '../src/media/media-rules.js';
import { ContentRejected, inspectPdf, processImage, processPdf } from '../src/media/processing.js';
import { ClamAvScanner, parseClamdReply, ScannerUnavailableError } from '../src/media/scanner.js';
import { contentDisposition } from '../src/media/storage.js';
import { EICAR, pdf } from './support/media-files.js';

describe('external links (M-D2)', () => {
  it('canonicalises the supported providers', () => {
    expect(parseExternalLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'video')).toEqual({ provider: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(parseExternalLink('https://m.youtube.com/shorts/dQw4w9WgXcQ', 'video')?.provider).toBe('youtube');
    expect(parseExternalLink('https://vimeo.com/123456789', 'video')).toEqual({ provider: 'vimeo', url: 'https://vimeo.com/123456789' });
    expect(parseExternalLink('https://my.matterport.com/show?m=SxQL3iGyoDo', 'virtual_tour')?.provider).toBe('matterport');
  });

  it('refuses anything else', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/channel/abc',
      'https://youtu.be/dQw4w9WgXcQ/extra',
      'https://user:pass@youtu.be/dQw4w9WgXcQ',
      'https://youtu.be:8443/dQw4w9WgXcQ',
      'https://vimeo.com/channels/staffpicks',
      'javascript:alert(1)',
    ]) {
      expect(parseExternalLink(url, 'video')).toBeNull();
    }
    expect(parseExternalLink('https://my.matterport.com/show/?m=bad!', 'virtual_tour')).toBeNull();
    expect(parseExternalLink('https://my.matterport.com/models/SxQL3iGyoDo', 'virtual_tour')).toBeNull();
  });
});

describe('media rules', () => {
  it('allows the right types and sizes per media type', () => {
    expect(allowedMimeTypes('photo')).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(allowedMimeTypes('brochure')).toEqual(['application/pdf']);
    expect(allowedMimeTypes('floor_plan')).toContain('application/pdf');
    expect(maxBytesFor('application/pdf')).toBe(20 * 1024 * 1024);
    expect(maxBytesFor('image/jpeg')).toBe(25 * 1024 * 1024);
    expect(isPlan('site_plan')).toBe(true);
    expect(isPlan('photo')).toBe(false);
  });

  it('cleans display file names and builds download headers', () => {
    expect(normaliseFileName('  ../plan\u0000\u0007 ground.pdf ')).toBe('.._plan ground.pdf');
    expect(normaliseFileName('\u0001')).toBe('file');
    expect(normaliseFileName('x'.repeat(300))).toHaveLength(200);
    expect(contentDisposition('Plan "A" – é.pdf')).toBe(`attachment; filename="Plan _A_ _ _.pdf"; filename*=UTF-8''Plan%20%22A%22%20%E2%80%93%20%C3%A9.pdf`);
  });

  it('lists every key a media item occupies', () => {
    expect(storageKeysOf({ storageKey: 'c/media/m/master.jpg', derivatives: { master: { key: 'c/media/m/master.jpg' }, variants: { thumb: { key: 'c/media/m/thumb-1.webp' } } } })).toEqual([
      'c/media/m/master.jpg',
      'c/media/m/thumb-1.webp',
    ]);
    expect(storageKeysOf({ storageKey: null, derivatives: {} })).toEqual([]);
  });
});

describe('PDF inspection', () => {
  const reason = (buffer: Buffer): string | null => {
    try {
      inspectPdf(buffer);
      return null;
    } catch (error) {
      return (error as ContentRejected).code;
    }
  };

  it('accepts a plain PDF and rejects broken or active ones', () => {
    expect(reason(pdf())).toBeNull();
    expect(reason(Buffer.from('not a pdf'))).toBe('invalid-pdf');
    expect(reason(pdf().subarray(0, 200))).toBe('invalid-pdf');
    expect(reason(pdf({ catalogExtra: '/AA << /O << /S /Launch >> >>' }))).toBe('unsafe-pdf');
    expect(reason(pdf({ catalogExtra: '/Names << /EmbeddedFiles 9 0 R >>' }))).toBe('unsafe-pdf');
    expect(reason(pdf({ hiddenInStream: '/S /JavaScript /JS (x)' }))).toBe('unsafe-pdf');
    expect(reason(pdf({ hiddenInStream: 'plain drawing 0 0 m' }))).toBeNull();
    expect(reason(pdf({ trailerExtra: '/Encrypt 5 0 R' }))).toBe('encrypted-pdf');
  });

  it('rejects damaged compressed streams', () => {
    const damaged = Buffer.from(pdf({ hiddenInStream: 'x'.repeat(500) }).toString('latin1').replace(/(\/FlateDecode >>\nstream\n)([\s\S]{4})/, '$1ZZZZ'), 'latin1');
    expect(deflateSync(Buffer.from('ok')).length).toBeGreaterThan(0);
    expect(reason(damaged)).toBe('invalid-pdf');
  });

  it('refuses PDFs Poppler cannot read', async () => {
    const unreadable = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(200, 0x20), Buffer.from('\n%%EOF\n', 'latin1')]);
    await expect(processPdf(unreadable)).rejects.toMatchObject({ code: 'invalid-pdf' });
  });

  it('maps undecodable images to a content rejection', async () => {
    await expect(processImage(Buffer.from('definitely not an image'), false)).rejects.toBeInstanceOf(ContentRejected);
  });
});

describe('clamd client', () => {
  let fake: Server;
  let port: number;
  let reply = 'stream: OK\0';
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    // Only for replies the real clamd cannot be made to send (garbage, silence).
    fake = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => undefined);
      socket.on('end', () => {
        if (reply !== 'hang') socket.end(reply);
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    port = (fake.address() as { port: number }).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => fake.close(resolve));
  });

  it('parses verdicts and treats anything else as unavailable', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ clean: true });
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND\0')).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR')).toThrow(ScannerUnavailableError);
    expect(() => parseClamdReply('')).toThrow(/empty reply/);
  });

  it('scans with the real clamd, in chunks', async () => {
    const services = inject('testServices');
    const scanner = new ClamAvScanner(services.clamavHost, services.clamavPort, 30_000);
    expect(await scanner.scan(Buffer.alloc(200_000, 0x41))).toEqual({ clean: true });
    expect((await scanner.scan(EICAR)).clean).toBe(false);
  });

  it('fails closed on errors, garbage and timeouts', async () => {
    await expect(new ClamAvScanner('127.0.0.1', 1, 2_000).scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
    reply = 'UNKNOWN COMMAND\0';
    await expect(new ClamAvScanner('127.0.0.1', port, 2_000).scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScannerUnavailableError);
    reply = 'hang';
    await expect(new ClamAvScanner('127.0.0.1', port, 1_000).scan(Buffer.from('x'))).rejects.toThrow(/timed out/);
  });
});
