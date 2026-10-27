# Helpers shared by export-gate.sh and export-freshness.sh (sourced, not run on its own).
# Dates: GNU date on the GitHub runner, BSD date on a Mac (the unit tests also run there).
# shellcheck shell=bash
# Needs: ENDPOINT, BUCKET (+ the AWS_* credentials); AWS_BIN = the aws command (default: aws), for tests.

aws_bin="${AWS_BIN:-aws}"

to_epoch() { # ISO timestamp in UTC (2026-10-27T19:03:11+00:00 or ...11.000Z) -> epoch seconds
  local t="$1" e
  e=$(date -u -d "$t" +%s 2>/dev/null) && { echo "$e"; return 0; }
  date -u -j -f "%Y-%m-%dT%H:%M:%S" "${t:0:19}" +%s 2>/dev/null
}

paris_epoch() { # $1 = YYYY-MM-DD, $2 = HH:MM, Paris wall-clock time -> epoch seconds (summer/winter time handled by the tz database)
  local e
  e=$(TZ=Europe/Paris date -d "$1 $2" +%s 2>/dev/null) && { echo "$e"; return 0; }
  TZ=Europe/Paris date -j -f "%Y-%m-%d %H:%M:%S" "$1 $2:00" +%s 2>/dev/null
}

day_before() { # YYYY-MM-DD -> the day before
  date -u -d "$1 -1 day" +%F 2>/dev/null || date -u -j -v-1d -f "%Y-%m-%d" "$1" +%F
}

paris_text() { # epoch -> "YYYY-MM-DD HH:MM" in Paris
  TZ=Europe/Paris date -d "@$1" +"%Y-%m-%d %H:%M" 2>/dev/null || TZ=Europe/Paris date -r "$1" +"%Y-%m-%d %H:%M"
}

# lastmod KEY: prints the key's LastModified (UTC ISO). Returns 0 present, 1 absent, 2 could not ask.
# Lists with the key itself as the prefix and keeps only the EXACT key (not inventory_books_X.csv.bak).
# An empty listing has no Contents at all: the JMESPath expression is then null, printed "None".
lastmod() {
  local t
  t=$("$aws_bin" s3api list-objects-v2 --endpoint-url "${ENDPOINT:-}" --bucket "${BUCKET:-}" --prefix "$1" \
        --query "Contents[?Key=='$1'].LastModified | [0]" --output text 2>/dev/null) || return 2
  case "$t" in '') return 2 ;; None|null) return 1 ;; esac
  echo "$t"
}

# written_since KEY CUTOFF_EPOCH: 0 = the key exists and was written at or after the cutoff;
# 1 = absent; 3 = exists but was written before the cutoff; 2 = could not ask / could not read its date.
# Sets WRITTEN (when it was written, in Paris time) for the messages.
written_since() {
  local rc ts
  WRITTEN=""
  WRITTEN=$(lastmod "$1"); rc=$?
  [ "$rc" = "0" ] || return "$rc"
  ts=$(to_epoch "$WRITTEN") || return 2
  [ -n "$ts" ] || return 2
  WRITTEN="$(paris_text "$ts" 2>/dev/null || echo "$WRITTEN") Paris time"
  [ "$ts" -ge "$2" ] && return 0
  return 3
}
