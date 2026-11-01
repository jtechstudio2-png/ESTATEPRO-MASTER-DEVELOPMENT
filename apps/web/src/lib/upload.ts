import type { CreateUploadBody, MediaDto, UploadTicketDto } from './api-schema';
import { bff } from './bff';

/** Upload rules mirrored from the API (media-rules.ts); the API and worker check again. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PDF_TYPE = 'application/pdf';
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PHOTOS_PER_LISTING = 60;
export const MAX_PLANS_PER_LISTING = 10;

export type UploadMediaType = CreateUploadBody['mediaType'];

export function allowedTypes(mediaType: UploadMediaType): readonly string[] {
  if (mediaType === 'photo') return IMAGE_TYPES;
  if (mediaType === 'brochure') return [PDF_TYPE];
  return [...IMAGE_TYPES, PDF_TYPE];
}

export function maxBytes(contentType: string): number {
  return contentType === PDF_TYPE ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
}

/** Why a file cannot be uploaded as this media type, before any request. */
export function precheck(file: { type: string; size: number }, mediaType: UploadMediaType): { code: 'type' | 'size'; limit?: number } | null {
  if (!allowedTypes(mediaType).includes(file.type)) return { code: 'type' };
  if (file.size > maxBytes(file.type)) return { code: 'size', limit: maxBytes(file.type) };
  return null;
}

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * PUT to the signed URL with progress (fetch has no upload progress). Only
 * the headers the ticket names are sent; the browser sets Content-Length.
 */
export function putWithProgress(ticket: UploadTicketDto, file: Blob, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(ticket.method, ticket.uploadUrl);
    for (const [name, value] of Object.entries(ticket.headers)) {
      if (name.toLowerCase() !== 'content-length' && name.toLowerCase() !== 'host') request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`storage-${request.status}`)));
    request.onerror = () => reject(new Error('network'));
    request.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => request.abort());
    request.send(file);
  });
}

/** G-2: request a ticket, PUT the bytes straight to storage, confirm; returns the pending media. */
export async function uploadFile(
  file: File,
  target: { propertyId: string; mediaType: UploadMediaType; unitId?: string; listingId?: string },
  hooks: { onStage: (stage: 'hashing' | 'uploading' | 'confirming') => void; onProgress: (fraction: number) => void; signal: AbortSignal },
): Promise<MediaDto> {
  hooks.onStage('hashing');
  const sha256 = await sha256Hex(file);
  const body: CreateUploadBody = {
    propertyId: target.propertyId,
    mediaType: target.mediaType,
    fileName: file.name,
    contentType: file.type,
    size: file.size,
    sha256,
    ...(target.unitId ? { unitId: target.unitId } : {}),
    ...(target.listingId ? { listingId: target.listingId } : {}),
  };
  const ticket = await bff<UploadTicketDto>('media/uploads', { method: 'POST', body, signal: hooks.signal, idempotencyKey: crypto.randomUUID() });
  hooks.onStage('uploading');
  await putWithProgress(ticket, file, hooks.onProgress, hooks.signal);
  hooks.onStage('confirming');
  return bff<MediaDto>(`media/uploads/${ticket.id}/confirm`, { method: 'POST', body: {}, signal: hooks.signal });
}
