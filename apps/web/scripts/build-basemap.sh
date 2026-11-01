#!/usr/bin/env bash
# Builds the self-hosted basemap (W-D4): one PMTiles archive of OpenStreetMap
# vector tiles (Protomaps basemap schema) covering the launch markets, plus
# the label glyphs, and optionally uploads both to the tile bucket (R2).
#
#   scripts/build-basemap.sh <protomaps-build-date YYYYMMDD> <output-dir> [--upload]
#
# Needs: pmtiles (github.com/protomaps/go-pmtiles) and curl; for --upload the
# AWS CLI with R2 credentials and these variables:
#   R2_ENDPOINT   https://<account>.r2.cloudflarestorage.com
#   TILES_BUCKET  bucket that serves the tile host (MAP_TILES_ORIGIN)
#
# Then set MAP_TILES_URL=pmtiles://https://<tile host>/basemap/estatepro.pmtiles
# and MAP_GLYPHS_URL=https://<tile host>/basemap/fonts/{fontstack}/{range}.pbf.
# Map data © OpenStreetMap contributors (ODbL); the attribution is shown on every map.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <YYYYMMDD> <output-dir> [--upload]" >&2
  exit 64
fi
build="$1"
out="$2"
upload="${3:-}"
if [[ ! "$build" =~ ^[0-9]{8}$ ]]; then
  echo "The build date must be YYYYMMDD (see https://maps.protomaps.com/builds)." >&2
  exit 64
fi
command -v pmtiles >/dev/null || { echo "pmtiles is not installed (github.com/protomaps/go-pmtiles)." >&2; exit 69; }

mkdir -p "$out/fonts"
region="$out/region.geojson"
# Launch markets (Ghana, Qatar, United Kingdom) as a multipolygon of
# generous boxes; add a market by adding its box. Lng/lat, WGS 84.
cat > "$region" <<'GEOJSON'
{"type":"Feature","properties":{},"geometry":{"type":"MultiPolygon","coordinates":[
 [[[-3.4,4.5],[1.4,4.5],[1.4,11.3],[-3.4,11.3],[-3.4,4.5]]],
 [[[50.6,24.4],[51.8,24.4],[51.8,26.3],[50.6,26.3],[50.6,24.4]]],
 [[[-8.8,49.8],[1.9,49.8],[1.9,61.0],[-8.8,61.0],[-8.8,49.8]]]
]}}
GEOJSON

echo "Extracting zoom 0-15 for the launch markets from Protomaps build $build…"
pmtiles extract "https://build.protomaps.com/${build}.pmtiles" "$out/estatepro.pmtiles" --region="$region" --maxzoom=15
pmtiles verify "$out/estatepro.pmtiles"

echo "Fetching glyphs (Noto Sans, Latin and Arabic ranges)…"
fonts="https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts"
for stack in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
  mkdir -p "$out/fonts/$stack"
  for range in 0-255 256-511 512-767 768-1023 1024-1279 1536-1791 1792-2047 2048-2303 64256-64511 64512-64767 64768-65023 65024-65279 65280-65535; do
    curl -fsS --retry 3 -o "$out/fonts/$stack/$range.pbf" "$fonts/${stack// /%20}/$range.pbf" || rm -f "$out/fonts/$stack/$range.pbf"
  done
done

if [[ "$upload" == "--upload" ]]; then
  : "${R2_ENDPOINT:?Set R2_ENDPOINT}" "${TILES_BUCKET:?Set TILES_BUCKET}"
  echo "Uploading to s3://$TILES_BUCKET/basemap/ …"
  aws s3 cp "$out/estatepro.pmtiles" "s3://$TILES_BUCKET/basemap/estatepro.pmtiles" --endpoint-url "$R2_ENDPOINT" \
    --content-type application/vnd.pmtiles --cache-control "public, max-age=86400"
  aws s3 cp "$out/fonts" "s3://$TILES_BUCKET/basemap/fonts" --recursive --endpoint-url "$R2_ENDPOINT" \
    --content-type application/x-protobuf --cache-control "public, max-age=604800"
fi
echo "Done: $out/estatepro.pmtiles"
