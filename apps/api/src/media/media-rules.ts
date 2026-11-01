/**
 * Media rules (M4 verification report §2–§4, ADR-005). HEIC is not accepted:
 * the bundled libvips cannot decode it; phones send JPEG through browsers.
 */
export const UPLOAD_MEDIA_TYPES = ['photo', 'floor_plan', 'site_plan', 'brochure'] as const;
export type UploadMediaType = (typeof UPLOAD_MEDIA_TYPES)[number];
export const LINK_MEDIA_TYPES = ['video', 'virtual_tour'] as const;
export type LinkMediaType = (typeof LINK_MEDIA_TYPES)[number];

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PDF_MIME = 'application/pdf';

const MB = 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * MB;
export const MAX_PDF_BYTES = 20 * MB;
export const MAX_IMAGE_PIXELS = 100_000_000;
export const MAX_IMAGE_SIDE = 12_000;
export const MIN_PLAN_SIDE = 800;
export const MAX_PDF_PAGES = 50;
export const MASTER_MAX_SIDE = 4_096;

export const MAX_PHOTOS_PER_LISTING = 60;
export const MAX_FLOOR_PLANS_PER_LISTING = 10;

/** Display sizes (longest side, never enlarged). */
export const VARIANTS = [
  { name: 'thumb', size: 320 },
  { name: 'small', size: 640 },
  { name: 'medium', size: 1280 },
  { name: 'large', size: 1920 },
] as const;
export type VariantName = (typeof VARIANTS)[number]['name'];

export function allowedMimeTypes(mediaType: UploadMediaType): readonly string[] {
  switch (mediaType) {
    case 'photo':
      return IMAGE_MIME_TYPES;
    case 'brochure':
      return [PDF_MIME];
    default:
      return [...IMAGE_MIME_TYPES, PDF_MIME];
  }
}

export function maxBytesFor(mime: string): number {
  return mime === PDF_MIME ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
}

/** Plans keep sharp lines: lossless variants and a PNG master. */
export function isPlan(mediaType: string): boolean {
  return mediaType === 'floor_plan' || mediaType === 'site_plan';
}

// ----------------------------------------------------------------------------- external links (M-D2)

export interface ExternalLink {
  provider: 'youtube' | 'vimeo' | 'matterport';
  url: string;
}

/**
 * Accepts YouTube, Vimeo and Matterport links only, returning a canonical URL
 * built from the extracted id (never the raw input), or null.
 */
export function parseExternalLink(raw: string, mediaType: LinkMediaType): ExternalLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const id = (pattern: RegExp, value: string | null | undefined) => (value && pattern.test(value) ? value : null);

  if (mediaType === 'video') {
    if (host === 'youtu.be') {
      const video = id(/^[A-Za-z0-9_-]{11}$/, url.pathname.slice(1));
      return video ? { provider: 'youtube', url: `https://www.youtube.com/watch?v=${video}` } : null;
    }
    if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
      const fromPath = /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
      const video = id(/^[A-Za-z0-9_-]{11}$/, url.pathname === '/watch' ? url.searchParams.get('v') : fromPath);
      return video ? { provider: 'youtube', url: `https://www.youtube.com/watch?v=${video}` } : null;
    }
    if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
      const video = /^\/(?:video\/)?(\d{6,12})$/.exec(url.pathname)?.[1];
      return video ? { provider: 'vimeo', url: `https://vimeo.com/${video}` } : null;
    }
    return null;
  }
  if (host === 'my.matterport.com' && url.pathname.replace(/\/$/, '') === '/show') {
    const model = id(/^[A-Za-z0-9]{11}$/, url.searchParams.get('m'));
    return model ? { provider: 'matterport', url: `https://my.matterport.com/show/?m=${model}` } : null;
  }
  return null;
}
