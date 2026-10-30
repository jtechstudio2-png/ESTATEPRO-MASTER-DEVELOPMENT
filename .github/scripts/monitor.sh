#!/usr/bin/env bash
# Samples memory, load and container usage every 5 s into $RUNNER_TEMP/monitor.log
# so a failed or cut-off job leaves evidence (CI root-cause investigation).
#   monitor.sh start | stop
set -euo pipefail
log="${RUNNER_TEMP:-/tmp}/monitor.log"
pidfile="${RUNNER_TEMP:-/tmp}/monitor.pid"
case "${1:-}" in
  start)
    : > "$log"
    nohup bash -c "while true; do
      printf '%s used_mb=%s avail_mb=%s load=%s\n' \"\$(date -u +%H:%M:%S)\" \
        \"\$(free -m | awk '/Mem:/{print \$3}')\" \"\$(free -m | awk '/Mem:/{print \$7}')\" \"\$(cut -d' ' -f1 /proc/loadavg)\"
      docker stats --no-stream --format '  {{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' 2>/dev/null || true
      sleep 5
    done" >> "$log" 2>&1 &
    echo $! > "$pidfile"
    ;;
  stop)
    if [[ -f "$pidfile" ]]; then kill "$(cat "$pidfile")" 2>/dev/null || true; fi
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 64
    ;;
esac
