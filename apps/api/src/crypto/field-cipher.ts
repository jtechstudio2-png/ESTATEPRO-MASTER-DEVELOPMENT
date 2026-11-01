import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Field-level envelope encryption (ADR-007 §4.3).
 *
 *   byte 0      format version (0x01)
 *   bytes 1–4   data-key version (uint32, big-endian)
 *   bytes 5–16  nonce (96-bit, random per value)
 *   bytes 17–   AES-256-GCM ciphertext ‖ 16-byte tag
 *
 * The authenticated data binds every value to its company, column and row,
 * so ciphertext copied anywhere else fails to decrypt.
 */
export const FORMAT_VERSION = 0x01;
const HEADER_LENGTH = 1 + 4 + 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** Where an encrypted value lives. Every part is part of the authenticated data. */
export interface FieldBinding {
  companyId: string;
  table: string;
  column: string;
  rowId: string;
}

/** Raised for any ciphertext that is malformed or fails authentication. Never carries the value. */
export class FieldDecryptionError extends Error {
  constructor(reason: string) {
    super(`Protected value could not be decrypted: ${reason}.`);
    this.name = 'FieldDecryptionError';
  }
}

export function associatedData(binding: FieldBinding): Buffer {
  for (const part of [binding.companyId, binding.table, binding.column, binding.rowId]) {
    if (part.length === 0 || part.includes('|')) throw new Error('Invalid field binding.');
  }
  return Buffer.from(`ep1|${binding.companyId.toLowerCase()}|${binding.table}.${binding.column}|${binding.rowId.toLowerCase()}`, 'utf8');
}

export function encryptField(key: Buffer, keyVersion: number, binding: FieldBinding, plaintext: string): Buffer {
  assertKey(key);
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 0xffffffff) throw new Error('Invalid key version.');
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt8(FORMAT_VERSION, 0);
  header.writeUInt32BE(keyVersion, 1);
  randomBytes(12).copy(header, 5);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(5, HEADER_LENGTH), { authTagLength: TAG_LENGTH });
  cipher.setAAD(associatedData(binding));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/** The data-key version a ciphertext was written with (to select the key before decrypting). */
export function keyVersionOf(ciphertext: Buffer): number {
  if (ciphertext.length < HEADER_LENGTH + TAG_LENGTH) throw new FieldDecryptionError('too short');
  if (ciphertext.readUInt8(0) !== FORMAT_VERSION) throw new FieldDecryptionError('unknown format');
  return ciphertext.readUInt32BE(1);
}

export function decryptField(key: Buffer, binding: FieldBinding, ciphertext: Buffer): string {
  assertKey(key);
  keyVersionOf(ciphertext);
  const nonce = ciphertext.subarray(5, HEADER_LENGTH);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
  const body = ciphertext.subarray(HEADER_LENGTH, ciphertext.length - TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new FieldDecryptionError('authentication failed');
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LENGTH) throw new Error('Field keys are 32 bytes.');
}
