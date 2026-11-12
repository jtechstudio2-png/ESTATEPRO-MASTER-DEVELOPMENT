import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The key-management port (ADR-007 E-D6). Company data keys are generated and
 * wrapped by a root key that never leaves the provider. The wrap context
 * (company and purpose) is authenticated, so a wrapped key only unwraps for
 * the company and purpose it was made for.
 */
export interface WrapContext {
  companyId: string;
  purpose: 'field' | 'lookup';
}

export interface GeneratedDataKey {
  /** 32-byte key in memory only; callers must not persist it. */
  plaintext: Buffer;
  wrapped: Buffer;
  /** Identifies the root key (and region) that wrapped it. */
  keyRef: string;
}

export interface KeyProvider {
  readonly name: string;
  generateDataKey(context: WrapContext): Promise<GeneratedDataKey>;
  unwrap(wrapped: Buffer, keyRef: string, context: WrapContext): Promise<Buffer>;
}

/** Raised when keys cannot be obtained: the request fails closed (ADR-007 E-D10). */
export class KeyUnavailableError extends Error {
  constructor(reason: string) {
    super(`Field encryption keys are unavailable: ${reason}.`);
    this.name = 'KeyUnavailableError';
  }
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

/** Used when no provider is configured: every operation fails closed. */
export class DisabledKeyProvider implements KeyProvider {
  readonly name = 'none';

  generateDataKey(): Promise<GeneratedDataKey> {
    return Promise.reject(new KeyUnavailableError('no key provider is configured (KEY_PROVIDER=none)'));
  }

  unwrap(): Promise<Buffer> {
    return Promise.reject(new KeyUnavailableError('no key provider is configured (KEY_PROVIDER=none)'));
  }
}

/**
 * Development and test provider: the root key comes from configuration and
 * wrapping is AES-256-GCM with the context as authenticated data. Refused in
 * production by configuration validation.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly name = 'local';
  private readonly rootKey: Buffer;
  private readonly keyRef: string;

  constructor(rootKeyBase64: string) {
    this.rootKey = Buffer.from(rootKeyBase64, 'base64');
    if (this.rootKey.length !== 32) throw new Error('The local root key must be 32 bytes.');
    this.keyRef = `local:${createHash('sha256').update(this.rootKey).digest('hex').slice(0, 16)}`;
  }

  generateDataKey(context: WrapContext): Promise<GeneratedDataKey> {
    const plaintext = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.rootKey, nonce);
    cipher.setAAD(contextData(context));
    const wrapped = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return Promise.resolve({ plaintext, wrapped, keyRef: this.keyRef });
  }

  unwrap(wrapped: Buffer, keyRef: string, context: WrapContext): Promise<Buffer> {
    if (keyRef !== this.keyRef) {
      return Promise.reject(new KeyUnavailableError(`the key was wrapped by a different root key (${keyRef})`));
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.rootKey, wrapped.subarray(0, 12));
      decipher.setAAD(contextData(context));
      decipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
      return Promise.resolve(Buffer.concat([decipher.update(wrapped.subarray(12, wrapped.length - 16)), decipher.final()]));
    } catch {
      return Promise.reject(new KeyUnavailableError('the wrapped key failed authentication'));
    }
  }
}

function contextData(context: WrapContext): Buffer {
  return Buffer.from(`ep-key|${context.companyId.toLowerCase()}|${context.purpose}`, 'utf8');
}
