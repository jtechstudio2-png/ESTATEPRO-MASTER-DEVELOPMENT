#!/usr/bin/env bash
# Starts the services the API and end-to-end tests need and waits until each
# one actually answers: SeaweedFS (S3 API), ClamAV (clamd PING and a stable
# signature database) and Poppler.
set -euo pipefail

mkdir -p "$RUNNER_TEMP/seaweed"
printf '%s' '{"identities":[{"name":"estatepro","credentials":[{"accessKey":"estatepro-test","secretKey":"estatepro-test-secret"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' > "$RUNNER_TEMP/seaweed/s3.json"
docker run -d --name seaweedfs -p 8333:8333 -v "$RUNNER_TEMP/seaweed":/config chrislusf/seaweedfs:3.80 \
  server -s3 -s3.port=8333 -s3.config=/config/s3.json -dir=/data
docker run -d --name clamav -p 3310:3310 clamav/clamav:1.4
sudo apt-get update -q && sudo apt-get install -y -q poppler-utils

wait_for() {
  local name="$1" tries="$2" delay="$3"; shift 3
  for _ in $(seq 1 "$tries"); do
    if "$@" >/dev/null 2>&1; then echo "$name ready"; return 0; fi
    sleep "$delay"
  done
  echo "::error::$name did not become ready"; docker logs --tail 50 "${name,,}" 2>&1 || true
  return 1
}

# An unauthenticated request gets an S3 XML answer (403) once the gateway is up.
wait_for SeaweedFS 60 2 bash -c 'code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8333/); [[ "$code" =~ ^[234] ]]'
# clamd answers only after the first signature download (about 1-3 minutes).
wait_for ClamAV 120 3 bash -c "printf 'zPING\0' | nc -q1 127.0.0.1 3310 | grep -q PONG"
# The image refreshes signatures right after start; wait until clamd has
# answered steadily for 20 s so tests do not meet a reload.
stable=0
for _ in $(seq 1 60); do
  if printf 'zPING\0' | nc -q1 127.0.0.1 3310 | grep -q PONG; then stable=$((stable + 1)); else stable=0; fi
  [[ $stable -ge 10 ]] && break
  sleep 2
done
[[ $stable -ge 10 ]] || { echo "::error::ClamAV is not answering steadily"; exit 1; }
printf 'zVERSION\0' | nc -q1 127.0.0.1 3310
pdfinfo -v 2>&1 | head -1
