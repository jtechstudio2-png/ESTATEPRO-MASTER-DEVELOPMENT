import type { Response } from 'express';

import { Problems } from './problem.js';

/** Sets the ETag of a versioned record (ADR-003 §4). */
export function setVersionEtag(res: Response, version: number): void {
  res.setHeader('ETag', `"${version}"`);
}

/**
 * Reads If-Match. Missing → 428; anything other than one strong ETag holding
 * a positive integer → 412 (it cannot match any version).
 */
export function requireIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') throw Problems.preconditionRequired();
  const match = /^"(\d{1,9})"$/.exec(header.trim());
  const version = match?.[1] !== undefined ? Number(match[1]) : NaN;
  if (!Number.isInteger(version) || version < 1) throw Problems.preconditionFailed();
  return version;
}
