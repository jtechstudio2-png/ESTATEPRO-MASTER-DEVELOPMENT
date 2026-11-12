import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';

import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProblemFilter } from '../src/common/problem.filter.js';
import { classify, S3Storage, StorageError, type StorageOperation } from '../src/media/storage.js';

/**
 * Issue #14: storage calls fail predictably under outage conditions. Each
 * case runs against a local endpoint that misbehaves in one way and checks
 * that the call fails within the configured bound, with the expected outcome,
 * attempts and metrics. Limits: connect 200 ms, request 300 ms, 2 attempts.
 */
const LIMITS = { connectTimeoutMs: 200, requestTimeoutMs: 300, maxAttempts: 2 };
/** Two attempts of (connect + request) plus the backoff between them, with room for a slow machine. */
const BOUND_MS = 2 * (LIMITS.connectTimeoutMs + LIMITS.requestTimeoutMs) + 1_500;

const storageAt = (endpoint: string) =>
  new S3Storage('outage-test', { endpoint, region: 'us-east-1', accessKeyId: 'key', secretAccessKey: 'secret', forcePathStyle: true }, LIMITS);

async function timed<T>(work: () => Promise<T>): Promise<{ error: unknown; ms: number }> {
  const started = Date.now();
  try {
    await work();
    return { error: null, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

describe('object storage under outage conditions (issue #14)', () => {
  let silent: Server;
  const sockets = new Set<Socket>();
  let failing: HttpServer;
  let refusing: HttpServer;
  let closedPort: number;
  const port = (server: Server | HttpServer) => (server.address() as AddressInfo).port;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    // Accepts connections and never answers.
    silent = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    // Answers every request with 503 (an overloaded store).
    failing = createHttpServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/xml' });
      res.end('<Error><Code>ServiceUnavailable</Code><Message>Slow down</Message></Error>');
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    // Answers every request with 403 (wrong credentials: not worth retrying).
    refusing = createHttpServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    });
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    // A port nothing listens on (connection refused).
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    closedPort = port(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([silent, failing, refusing].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('gives up on an endpoint that accepts connections but never answers, within the bound, after retrying', async () => {
    const storage = storageAt(`http://127.0.0.1:${port(silent)}`);
    try {
      const cases: Array<[StorageOperation, () => Promise<unknown>]> = [
        ['head', () => storage.head('a/b')],
        ['read', () => storage.read('a/b', 10)],
        ['write', () => storage.write('a/b', Buffer.from('x'), 'text/plain')],
        ['remove', () => storage.remove(['a/b'])],
      ];
      for (const [operation, call] of cases) {
        const { error, ms } = await timed(call);
        expect(error, operation).toBeInstanceOf(StorageError);
        expect(error).toMatchObject({ operation, outcome: 'timeout', attempts: 2, transient: true });
        expect(ms).toBeLessThan(BOUND_MS);
      }
      const metrics = storage.metrics.snapshot();
      expect(metrics.head).toMatchObject({ calls: 1, outcomes: { timeout: 1, success: 0 }, retries: 1 });
      expect(metrics.write).toMatchObject({ calls: 1, outcomes: { timeout: 1 } });
      expect(metrics.read?.maxMs).toBeGreaterThanOrEqual(2 * LIMITS.requestTimeoutMs - 50);
    } finally {
      storage.destroy();
    }
  }, 30_000);

  it('fails fast when the endpoint refuses connections, after the allowed retries', async () => {
    const storage = storageAt(`http://127.0.0.1:${closedPort}`);
    try {
      const { error, ms } = await timed(() => storage.write('a/b', Buffer.from('x'), 'text/plain'));
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ operation: 'write', outcome: 'retry_exhausted', attempts: 2 });
      expect(ms).toBeLessThan(BOUND_MS);
      expect(storage.metrics.snapshot().write).toMatchObject({ outcomes: { retry_exhausted: 1 }, retries: 1 });
    } finally {
      storage.destroy();
    }
  }, 30_000);

  it('gives up on an unroutable address within the connection timeout', async () => {
    // TEST-NET-1 (RFC 5737): never routed, so the connection either hangs (timeout) or is refused by the network.
    const storage = storageAt('http://192.0.2.1:9');
    try {
      const { error, ms } = await timed(() => storage.head('a/b'));
      expect(error).toBeInstanceOf(StorageError);
      expect(['timeout', 'retry_exhausted']).toContain((error as StorageError).outcome);
      expect(ms).toBeLessThan(BOUND_MS);
    } finally {
      storage.destroy();
    }
  }, 30_000);

  it('retries a store that answers 5xx and reports it exhausted; does not retry a 4xx', async () => {
    const overloaded = storageAt(`http://127.0.0.1:${port(failing)}`);
    const denied = storageAt(`http://127.0.0.1:${port(refusing)}`);
    try {
      const { error } = await timed(() => overloaded.write('a/b', Buffer.from('x'), 'text/plain'));
      expect(error).toMatchObject({ outcome: 'retry_exhausted', attempts: 2, transient: true });
      const rejected = await timed(() => denied.write('a/b', Buffer.from('x'), 'text/plain'));
      expect(rejected.error).toMatchObject({ outcome: 'client_error', attempts: 1, transient: false });
      expect(denied.metrics.snapshot().write).toMatchObject({ retries: 0, outcomes: { client_error: 1 } });
    } finally {
      overloaded.destroy();
      denied.destroy();
    }
  }, 30_000);

  it('answers an outage with 503 storage-unavailable, and a misconfiguration with 500', () => {
    const run = (exception: unknown) => {
      const json = vi.fn((_body: Record<string, unknown>) => undefined);
      const type = vi.fn((_contentType: string) => ({ json }));
      const status = vi.fn((_code: number) => ({ type }));
      const host = {
        switchToHttp: () => ({
          getRequest: () => ({ requestId: 'req-1', originalUrl: '/api/v1/x', method: 'POST', path: '/api/v1/x' }),
          getResponse: () => ({ status }),
        }),
      };
      new ProblemFilter().catch(exception, host as never);
      return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
    };
    expect(run(new StorageError('write', 'timeout', 3))).toMatchObject({ status: 503, body: { type: 'urn:estatepro:problem:storage-unavailable' } });
    expect(run(new StorageError('read', 'retry_exhausted', 3))).toMatchObject({ status: 503 });
    expect(run(new StorageError('head', 'client_error', 1))).toMatchObject({ status: 500 });
  });

  it('classifies failures by kind', () => {
    expect(classify(Object.assign(new Error('socket hang'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classify(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('timeout');
    expect(classify({ $metadata: { httpStatusCode: 429 } })).toBe('retry_exhausted');
    expect(classify({ $metadata: { httpStatusCode: 404 } })).toBe('client_error');
    expect(classify(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe('retry_exhausted');
  });
});
