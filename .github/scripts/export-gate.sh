#!/usr/bin/env bash
# Idempotent "should this scheduled export run now?" gate, shared by
# accounting-export-monthly.yml and inventory-export.yml.
#
# The old gate ("exactly 07:00 Paris on the 1st") ended GREEN without exporting when GitHub
# delayed a scheduled run past that hour, and nothing noticed. This gate asks Backblaze instead:
#
#   accounting  days 1-3 of the month (Paris), ANY hour: run when last month's
#               accounting-exports/<year>/accounting_<YYYY-MM>.csv is ABSENT, skip when it exists.
#   inventory   hours 21-23 (Paris): run when today's inventory-exports/inventory_books_<date>.csv
#               is ABSENT (it is the last dated file the export uploads), skip when it exists.
#   manual      IGNORE=true (the default of a manual run) or an explicit month: always run.
#
# If Backblaze cannot be asked (network, credentials) the gate runs the export anyway and says so
# (a second export only overwrites the same files; a missing one is the worse outcome).
#
# Usage: export-gate.sh accounting|inventory
# Env:   IGNORE (true = manual run, always go on)   MONTH_INPUT (accounting, YYYY-MM, optional)
#        BUCKET ENDPOINT (+ the AWS_* credentials)  GITHUB_OUTPUT (default: stdout)
#        GATE_NOW "YYYY-MM-DD HH" = the Paris time, for tests (default: the real clock)
#        AWS_BIN = the aws command (default: aws), for tests.
# Output: run=true|false
set -u

kind="${1:-}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
aws_bin="${AWS_BIN:-aws}"

decide() { # $1 = true|false, $2 = reason
  echo "run=$1" >> "$out"
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

# present KEY -> 0 present, 1 absent, 2 could not ask
present() {
  local n
  # shellcheck disable=SC2016  # the backticks are JMESPath literals, not shell
  n=$("$aws_bin" s3api list-objects-v2 --endpoint-url "${ENDPOINT:-}" --bucket "${BUCKET:-}" --prefix "$1" \
        --query 'length(Contents || `[]`)' --output text 2>/dev/null) || return 2
  case "$n" in ''|None) return 2 ;; esac
  [ "$n" -gt 0 ] && return 0
  return 1
}

check_absent() { # $1 = key, $2 = what, runs the export unless it exists
  present "$1"; rc=$?
  if [ "$rc" = "0" ]; then decide false "$2 already exists in Backblaze ($1): nothing to do."; fi
  if [ "$rc" = "1" ]; then decide true "$2 is not in Backblaze yet ($1)."; fi
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
    check_absent "accounting-exports/${py}/accounting_${label}.csv" "The accounting export for ${label}"
    ;;
  inventory)
    if [ "${IGNORE:-}" = "true" ]; then decide true "manual run (time and file checks skipped)."; fi
    if [ "$hour" -lt 21 ]; then decide false "It is ${hour}h in Paris, before 21h: a later schedule does the export (two exist for summer/winter time)."; fi
    check_absent "inventory-exports/inventory_books_${date_part}.csv" "Tonight's inventory export (${date_part})"
    ;;
  *)
    echo "Usage: export-gate.sh accounting|inventory" >&2
    exit 2
    ;;
esac
