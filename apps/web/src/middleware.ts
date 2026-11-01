import { type NextRequest, NextResponse } from 'next/server';

/**
 * Content-Security-Policy with a per-request nonce. The app loads scripts,
 * styles, fonts, map tiles and API data only from its own origin; images may
 * also come from the media store (signed URLs) and tiles from the tile host.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const mediaOrigin = process.env['MEDIA_ORIGIN'] ?? '';
  const tilesOrigin = process.env['MAP_TILES_ORIGIN'] ?? '';
  const dev = process.env['NODE_ENV'] === 'development';
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${mediaOrigin} ${tilesOrigin}`.trim(),
    `connect-src 'self' ${mediaOrigin} ${tilesOrigin}`.trim(),
    "font-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "form-action 'self' " + (process.env['OIDC_ISSUER'] ?? ''),
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  // Lets server layouts send people back to the page they asked for after sign-in.
  headers.set('x-pathname', request.nextUrl.pathname + request.nextUrl.search);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico|basemap/).*)' }],
};
