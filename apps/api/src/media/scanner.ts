import { createConnection } from 'node:net';

export const SCANNER = Symbol('SCANNER');

export type ScanResult = { clean: true } | { clean: false; signature: string };

/** Raised when the scanner cannot give a verdict: the file must stay pending (fail closed). */
export class ScannerUnavailableError extends Error {}

export interface MalwareScanner {
  scan(content: Buffer): Promise<ScanResult>;
}

const CHUNK = 64 * 1024;

/** clamd over TCP using the INSTREAM command (null-terminated "z" variant). */
export class ClamAvScanner implements MalwareScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  scan(content: Buffer): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let reply = '';
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new ScannerUnavailableError(message));
      };
      socket.setTimeout(this.timeoutMs, () => fail('clamd timed out'));
      socket.on('error', (error) => fail(`clamd unavailable: ${error.message}`));
      socket.on('data', (chunk: Buffer) => (reply += chunk.toString('utf8')));
      socket.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(parseClamdReply(reply));
        } catch (error) {
          reject(error instanceof Error ? error : new ScannerUnavailableError(String(error)));
        }
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < content.length; offset += CHUNK) {
          const chunk = content.subarray(offset, offset + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}

/** "stream: OK", "stream: <signature> FOUND" or an error line. */
export function parseClamdReply(raw: string): ScanResult {
  const reply = raw.replace(/\0/g, '').trim();
  if (reply === 'stream: OK') return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { clean: false, signature: found[1]! };
  throw new ScannerUnavailableError(`clamd could not scan the file: ${reply || 'empty reply'}`);
}
