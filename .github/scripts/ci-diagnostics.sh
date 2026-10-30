#!/usr/bin/env bash
# Summarises a test job for diagnosis: failing tests (from the JSON report),
# peak memory and load (from monitor.sh), out-of-memory kills, container
# restarts and the service logs' last lines. Writes the summary to the job
# summary and, where permitted, to this job's check-run output, so it can be
# read without downloading logs.
#   ci-diagnostics.sh "<job name>" <report.json> [vitest|playwright]
set -uo pipefail
job_name="$1"
report="${2:-}"
kind="${3:-vitest}"
log="${RUNNER_TEMP:-/tmp}/monitor.log"
out="${RUNNER_TEMP:-/tmp}/diagnostics.md"

failures="(no report)"
totals=""
if [[ -f "$report" ]]; then
  parsed="$(node -e '
    const fs = require("fs");
    const [file, kind] = process.argv.slice(1);
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const failed = [];
    let summary = "";
    if (kind === "playwright") {
      const walk = (s, path) => {
        for (const spec of s.specs ?? []) for (const t of spec.tests ?? [])
          if (t.results?.some((x) => x.status !== "passed" && x.status !== "skipped")) failed.push(`${spec.file}: ${spec.title}: ${(t.results.at(-1)?.error?.message ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter((line) => line.trim()).slice(0, 12).join(" ¦ ").slice(0, 1500)}`);
        for (const child of s.suites ?? []) walk(child, path);
      };
      for (const s of r.suites ?? []) walk(s, "");
      summary = `expected=${r.stats?.expected} unexpected=${r.stats?.unexpected} flaky=${r.stats?.flaky} skipped=${r.stats?.skipped}`;
    } else {
      for (const f of r.testResults ?? []) {
        if (f.status === "failed" && (f.assertionResults ?? []).every((a) => a.status !== "failed")) failed.push(`${f.name.replace(/.*\/test\//, "test/")}: ${(f.message ?? "").split("\n")[0].slice(0, 200)}`);
        for (const a of f.assertionResults ?? []) if (a.status === "failed") failed.push(`${f.name.replace(/.*\/test\//, "test/")}: ${a.fullName}: ${(a.failureMessages?.[0] ?? "").split("\n")[0].slice(0, 200)}`);
      }
      summary = `passed=${r.numPassedTests} failed=${r.numFailedTests} total=${r.numTotalTests}`;
    }
    console.log(summary + "|||" + (failed.length ? failed.join(" || ") : "none"));
  ' "$report" "$kind" 2>/dev/null || echo "unreadable report|||unparseable")"
  totals="${parsed%%|||*}"
  failures="${parsed#*|||}"
fi

peak_mem="$(awk -F'used_mb=' '/used_mb=/{split($2,a," "); if (a[1]>m) m=a[1]} END{print m+0}' "$log" 2>/dev/null)"
min_avail="$(awk -F'avail_mb=' '/avail_mb=/{split($2,a," "); if (min=="" || a[1]<min) min=a[1]} END{print min+0}' "$log" 2>/dev/null)"
peak_load="$(awk -F'load=' '/load=/{if ($2>m) m=$2} END{print m+0}' "$log" 2>/dev/null)"
oom="$(sudo dmesg 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -5 | tr '\n' ' ')"
restarts="$(docker ps -a --format '{{.Names}}' 2>/dev/null | while read -r n; do printf '%s=%s ' "$n" "$(docker inspect -f '{{.RestartCount}}/{{.State.Status}}' "$n")"; done)"
clam="$(docker logs --tail 8 clamav 2>&1 | tr '\n' ' ' | cut -c1-600)"
seaweed="$(docker logs --tail 25 seaweedfs 2>&1 | grep -viE 'debug' | tail -12 | tr '\n' ' ' | cut -c1-1500)"
cores="$(nproc)"
mem_total="$(free -m | awk '/Mem:/{print $2}')"

{
  echo "### CI diagnostics: ${job_name}"
  echo ""
  echo "| | |"
  echo "|---|---|"
  echo "| Runner | ${cores} vCPU, ${mem_total} MB RAM |"
  echo "| Tests | ${totals:-n/a} |"
  echo "| Failures | ${failures} |"
  echo "| Peak memory used | ${peak_mem} MB (lowest available ${min_avail} MB) |"
  echo "| Peak load (1 min) | ${peak_load} |"
  echo "| OOM kills | ${oom:-none} |"
  echo "| Containers (restarts/state) | ${restarts:-none} |"
  echo "| ClamAV last lines | ${clam:-n/a} |"
  echo "| SeaweedFS last lines | ${seaweed:-n/a} |"
} > "$out"

cat "$out"
bash "$(dirname "$0")/post-check-summary.sh" "$job_name" "$out" "CI diagnostics"
exit 0
