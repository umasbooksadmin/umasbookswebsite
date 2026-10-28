#!/usr/bin/env bash
# Idempotent "should this scheduled export run now?" gate, shared by
# accounting-export-monthly.yml and inventory-export.yml.
#
# GitHub starts scheduled runs late (often 2-4 hours) or drops them, so the gate does not trust
# the clock alone: it asks Backblaze whether the export it is deciding for is already done, and
# uses the file's LastModified so that a manual run (or a test run) never counts as the real one.
#
#   accounting  days 1-3 of the month (Paris), ANY hour: run unless last month's
#               accounting-exports/<year>/accounting_<YYYY-MM>.csv exists AND was written after
#               that month ended (a file written during the month is a test run, not the export).
#   inventory   decides for ONE Paris day D and outputs it (day=D); the workflow exports under
#               that date (export-inventory-csv.js --date D):
#                 hours 21-23 (Paris): D = today
#                 hours 0-5:           D = yesterday (a run GitHub delayed past midnight)
#                 hours 6-20:          skip
#               Run unless inventory-exports/inventory_books_<D>.csv exists AND was written at or
#               after 21:00 Paris on D ("the end-of-day export for D"). A file written earlier on D
#               (a manual run during the day) does not count, so that evening's export still runs.
#   manual      IGNORE=true (the default of a manual run) or an explicit month: always run.
#               A manual inventory run exports under today's Paris date (day=today, manual=true).
#
# If Backblaze cannot be asked (network, credentials) the gate runs the export anyway and says so
# (a second export only overwrites the same files; a missing one is the worse outcome).
#
# Usage: export-gate.sh accounting|inventory
# Env:   IGNORE (true = manual run, always go on)   MONTH_INPUT (accounting, YYYY-MM, optional)
#        BUCKET ENDPOINT (+ the AWS_* credentials)  GITHUB_OUTPUT (default: stdout)
#        GATE_NOW "YYYY-MM-DD HH" = the Paris time, for tests (default: the real clock)
#        AWS_BIN = the aws command (default: aws), for tests.
# Output: run=true|false   (inventory also) day=YYYY-MM-DD   manual=true|false
set -u

kind="${1:-}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
# shellcheck source-path=SCRIPTDIR source=export-lib.sh
. "$(dirname "$0")/export-lib.sh" # helpers; AWS_BIN = the aws command (default: aws)

for_day=""
manual="false"
decide() { # $1 = true|false, $2 = reason
  echo "run=$1" >> "$out"
  if [ -n "$for_day" ]; then { echo "day=$for_day"; echo "manual=$manual"; } >> "$out"; fi
  if [ "$1" = "true" ]; then echo "Gate ($kind): RUN - $2"; else echo "::notice title=Export skipped::$2"; echo "Gate ($kind): SKIP - $2"; fi
  exit 0
}

if [ -n "${GATE_NOW:-}" ]; then paris="$GATE_NOW"; else paris=$(TZ=Europe/Paris date +"%Y-%m-%d %H"); fi
date_part="${paris% *}"
hour=$((10#${paris#* }))
year=$((10#${date_part%%-*}))
rest="${date_part#*-}"
month=$((10#${rest%%-*}))
day=$((10#${rest#*-}))

# check_done KEY CUTOFF_EPOCH WHAT CUTOFF_TEXT: skip if KEY was written at or after the cutoff, else run.
check_done() {
  local rc
  if [ -z "$2" ]; then
    echo "::warning title=Export gate could not compute a date::Could not compute $4: running the export anyway."
    decide true "could not compute the cut-off time, exporting to be safe."
  fi
  written_since "$1" "$2"; rc=$?
  case "$rc" in
    0) decide false "$3 is already in Backblaze ($1, written $WRITTEN): nothing to do." ;;
    1) decide true "$3 is not in Backblaze yet ($1)." ;;
    3) decide true "$1 exists but was written $WRITTEN, before $4: that was a manual or test run, not $3. Exporting now." ;;
  esac
  echo "::warning title=Export gate could not read Backblaze::Could not check whether $1 exists: running the export anyway."
  decide true "could not check Backblaze, exporting to be safe."
}

case "$kind" in
  accounting)
    if [ "${IGNORE:-}" = "true" ]; then decide true "manual run (time and file checks skipped)."; fi
    if [ -n "${MONTH_INPUT:-}" ]; then decide true "manual run for month ${MONTH_INPUT}."; fi
    if [ "$day" -gt 3 ]; then decide false "Paris date is ${date_part} (day $day): the monthly export only runs on days 1-3 of the month."; fi
    py=$year; pm=$((month - 1))
    if [ "$pm" -lt 1 ]; then pm=12; py=$((year - 1)); fi
    label=$(printf '%04d-%02d' "$py" "$pm")
    month_start=$(printf '%04d-%02d-01' "$year" "$month") # ${label} ended here: a file written later is the real export
    cutoff=$(paris_epoch "$month_start" "00:00")
    check_done "accounting-exports/${py}/accounting_${label}.csv" "$cutoff" "the accounting export for ${label}" "the end of ${label} (${month_start} 00:00 Paris)"
    ;;
  inventory)
    if [ "${IGNORE:-}" = "true" ]; then
      for_day="$date_part"; manual="true"
      decide true "manual run (time and file checks skipped): exporting the inventory as of now, under ${for_day}."
    fi
    if [ "$hour" -le 5 ]; then
      # GitHub often starts scheduled runs 2-4 hours late: a run after midnight still owes yesterday's export.
      for_day=$(day_before "$date_part")
    elif [ "$hour" -lt 21 ]; then
      decide false "It is ${hour}h in Paris, before 21h: a later schedule does the export (several exist for summer/winter time and delays)."
    else
      for_day="$date_part"
    fi
    cutoff=$(paris_epoch "$for_day" "21:00")
    check_done "inventory-exports/inventory_books_${for_day}.csv" "$cutoff" "the end-of-day inventory export for ${for_day}" "21:00 Paris on ${for_day}"
    ;;
  *)
    echo "Usage: export-gate.sh accounting|inventory" >&2
    exit 2
    ;;
esac
