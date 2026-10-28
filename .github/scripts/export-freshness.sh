#!/usr/bin/env bash
# Daily check, used by backup-freshness.yml, that the two scheduled exports really happened.
# The export workflows email when they FAIL, but a run that never happens (disabled workflow,
# dropped schedule) is silent; this looks at Backblaze itself, with the SAME rules as
# export-gate.sh (a manual or test run does not count as the scheduled export):
#
#   accounting  from the 3rd of the month (Paris) last month's
#               accounting-exports/<year>/accounting_<YYYY-MM>.csv must exist, written after
#               that month ended.
#   inventory   the end-of-day export of the last evening whose retry window is over must exist:
#               inventory-exports/inventory_books_<D>.csv written at or after 21:00 Paris on D,
#               where D = yesterday (from 06:00 Paris; before that, the day before yesterday,
#               since a delayed run may still be exporting yesterday).
#
# Never fails the step: it writes outputs and the workflow sends the alert mail, so the existing
# "no fresh backup" alert is not triggered by it.
# Usage: export-freshness.sh accounting|inventory
# Env:   BUCKET ENDPOINT (+ the AWS_* credentials)   GITHUB_OUTPUT (default: stdout)
#        GATE_NOW "YYYY-MM-DD HH" Paris time, AWS_BIN: for tests.
# Output: missing=true|false   label=<YYYY-MM or YYYY-MM-DD>   reason=<one line>
set -u

kind="${1:-}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
# shellcheck source-path=SCRIPTDIR source=export-lib.sh
. "$(dirname "$0")/export-lib.sh" # helpers; AWS_BIN = the aws command (default: aws)

emit() { # $1 = missing true|false, $2 = reason, $3 = label
  { echo "missing=$1"; echo "label=${3:-}"; echo "reason=$2"; } >> "$out"
  if [ "$1" = "true" ]; then echo "::error title=Export missing::$2"; else echo "OK ($kind): $2"; fi
  exit 0
}

if [ -n "${GATE_NOW:-}" ]; then paris="$GATE_NOW"; else paris=$(TZ=Europe/Paris date +"%Y-%m-%d %H"); fi
date_part="${paris% *}"
hour=$((10#${paris#* }))
year=$((10#${date_part%%-*}))
rest="${date_part#*-}"
month=$((10#${rest%%-*}))
day=$((10#${rest#*-}))

case "$kind" in
  accounting)
    py=$year; pm=$((month - 1))
    if [ "$pm" -lt 1 ]; then pm=12; py=$((year - 1)); fi
    label=$(printf '%04d-%02d' "$py" "$pm")
    if [ "$day" -lt 3 ]; then emit false "Day $day of the month: the export for ${label} is only required from the 3rd." "$label"; fi
    key="accounting-exports/${py}/accounting_${label}.csv"
    month_start=$(printf '%04d-%02d-01' "$year" "$month")
    cutoff=$(paris_epoch "$month_start" "00:00")
    [ -n "$cutoff" ] || emit true "Could not compute the end of ${label}." "$label"
    written_since "$key" "$cutoff"
    case "$?" in
      0) emit false "${key} exists (written ${WRITTEN})." "$label" ;;
      1) emit true "The accounting export for ${label} is missing: ${key} is not in Backblaze." "$label" ;;
      3) emit true "The accounting export for ${label} is missing: ${key} was written ${WRITTEN}, before the month ended (a test run), and the real export has not replaced it." "$label" ;;
      *) emit true "Could not check Backblaze for ${key}." "$label" ;;
    esac
    ;;
  inventory)
    owed=$(day_before "$date_part")
    if [ "$hour" -le 5 ]; then owed=$(day_before "$owed"); fi
    key="inventory-exports/inventory_books_${owed}.csv"
    cutoff=$(paris_epoch "$owed" "21:00")
    [ -n "$cutoff" ] || emit true "Could not compute 21:00 Paris on ${owed}." "$owed"
    written_since "$key" "$cutoff"
    case "$?" in
      0) emit false "the end-of-day inventory export for ${owed} is there (${key}, written ${WRITTEN})." "$owed" ;;
      1) emit true "The end-of-day inventory export for ${owed} is missing: ${key} is not in Backblaze." "$owed" ;;
      3) emit true "The end-of-day inventory export for ${owed} is missing: ${key} was only written by a run during the day (${WRITTEN}), not at or after 21:00 Paris." "$owed" ;;
      *) emit true "Could not check Backblaze for ${key}." "$owed" ;;
    esac
    ;;
  *)
    echo "Usage: export-freshness.sh accounting|inventory" >&2
    exit 2
    ;;
esac
