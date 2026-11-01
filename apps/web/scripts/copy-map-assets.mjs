// Copies MapLibre's worker into public/basemap so it is served from our own
// origin (CSP worker-src 'self'; W-D4 keeps every map asset self-hosted).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.css'));
const target = new URL('../public/basemap/', import.meta.url).pathname;
mkdirSync(target, { recursive: true });
copyFileSync(join(dist, 'maplibre-gl-worker.mjs'), join(target, 'maplibre-gl-worker.mjs'));
console.log('Copied the MapLibre worker to public/basemap/.');
