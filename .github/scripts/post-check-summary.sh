#!/usr/bin/env bash
# Writes a markdown file to the job summary and, where permitted, to the
# job's check-run output (readable through the checks API).
#   post-check-summary.sh "<job name>" <file.md> "<title>"
set -uo pipefail
job_name="$1"; file="$2"; title="${3:-CI summary}"
[[ -f "$file" ]] || exit 0
cat "$file" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
if [[ -n "${GH_TOKEN:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
  job_id="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs" --paginate \
    --jq ".jobs[] | select(.name == \"${job_name}\") | .id" 2>/dev/null | head -1)"
  if [[ -n "$job_id" ]]; then
    gh api -X PATCH "repos/${GITHUB_REPOSITORY}/check-runs/${job_id}" \
      -f "output[title]=${title}" -f "output[summary]=$(head -c 60000 "$file")" >/dev/null 2>&1 \
      || echo "::notice::Could not write to the check run (permission); see the job summary."
  fi
fi
exit 0
