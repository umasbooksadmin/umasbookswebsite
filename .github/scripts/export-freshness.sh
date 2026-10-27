#!/usr/bin/env bash
# Daily check, used by backup-freshness.yml, that the two scheduled exports really happened.
# The export workflows email when they FAIL, but a run that never happens (disabled workflow,
# dropped schedule) is silent; this looks at Backblaze itself.
#
#   accounting  from the 3rd of the month (Paris) last month's
#               accounting-exports/<year>/accounting_<YYYY-MM>.csv must exist.
#   inventory   inventory-exports/ must hold a file written in the last MAX_AGE_HOURS (36) hours.
#
# Never fails the step: it writes outputs and the workflow sends the alert mail, so the existing
# "no fresh backup" alert is not triggered by it.
# Usage: export-freshness.sh accounting|inventory
# Env:   BUCKET ENDPOINT (+ the AWS_* credentials)   GITHUB_OUTPUT (default: stdout)
#        GATE_NOW "YYYY-MM-DD HH" Paris time, FRESH_NOW_EPOCH = now in seconds, AWS_BIN: for tests.
# Output: missing=true|false   label=<YYYY-MM>   reason=<one line>
set -u

kind="${1:-}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
aws_bin="${AWS_BIN:-aws}"
max_age_hours="${MAX_AGE_HOURS:-36}"

emit() { # $1 = missing true|false, $2 = reason, $3 = label
  { echo "missing=$1"; echo "label=${3:-}"; echo "reason=$2"; } >> "$out"
  if [ "$1" = "true" ]; then echo "::error title=Export missing::$2"; else echo "OK ($kind): $2"; fi
  exit 0
}

to_epoch() { # ISO timestamp -> epoch seconds (GNU date on the runner, BSD date on a Mac)
  local t="$1" e
  e=$(date -u -d "$t" +%s 2>/dev/null) && { echo "$e"; return 0; }
  date -u -j -f "%Y-%m-%dT%H:%M:%S" "${t:0:19}" +%s
}

if [ -n "${GATE_NOW:-}" ]; then paris="$GATE_NOW"; else paris=$(TZ=Europe/Paris date +"%Y-%m-%d %H"); fi
date_part="${paris% *}"
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
    # shellcheck disable=SC2016  # the backticks are JMESPath literals, not shell
    n=$("$aws_bin" s3api list-objects-v2 --endpoint-url "${ENDPOINT:-}" --bucket "${BUCKET:-}" --prefix "$key" \
          --query 'length(Contents || `[]`)' --output text 2>/dev/null) || n=""
    case "$n" in
      ''|None) emit true "Could not check Backblaze for ${key}." "$label" ;;
      0) emit true "The accounting export for ${label} is missing: ${key} is not in Backblaze." "$label" ;;
      *) emit false "${key} exists." "$label" ;;
    esac
    ;;
  inventory)
    # shellcheck disable=SC2016  # the backticks are JMESPath literals, not shell
    when=$("$aws_bin" s3api list-objects-v2 --endpoint-url "${ENDPOINT:-}" --bucket "${BUCKET:-}" --prefix "inventory-exports/" \
             --query 'sort_by(Contents || `[]`, &LastModified)[-1].LastModified' --output text 2>/dev/null) || when="ERR"
    case "$when" in
      ERR) emit true "Could not check Backblaze for inventory-exports/." "" ;;
      ''|None) emit true "inventory-exports/ is empty: no inventory export has been stored." "" ;;
    esac
    now="${FRESH_NOW_EPOCH:-$(date -u +%s)}"
    ts=$(to_epoch "$when") || emit true "Could not read the date of the newest inventory file ($when)." ""
    age=$(( (now - ts) / 3600 ))
    if [ "$age" -gt "$max_age_hours" ]; then emit true "The newest file in inventory-exports/ is ${age} hours old (limit ${max_age_hours}): the nightly inventory export has not run." ""; fi
    emit false "the newest inventory file is ${age} hours old." ""
    ;;
  *)
    echo "Usage: export-freshness.sh accounting|inventory" >&2
    exit 2
    ;;
esac
