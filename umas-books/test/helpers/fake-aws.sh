#!/usr/bin/env bash
# Fake `aws` for the export tests (test/helpers/workflowSim.js, test/unit/exportGate.test.js).
# The bucket is the file S3_STATE: one "key<TAB>LastModified" line per object.
#   aws s3 cp SRC s3://BUCKET/KEY          stores KEY with LastModified = FAKE_CLOCK (logged to S3_LOG)
#   aws s3api list-objects-v2 --prefix P --query Q --output text
#       answers ONLY the queries below, exactly as the real CLI prints them (null -> "None"),
#       and fails on any other query so a change in the scripts cannot pass against a guess.
# FAIL=1: every call fails (Backblaze unreachable).
[ "${FAIL:-}" = "1" ] && { echo "boom" >&2; exit 255; }
state="${S3_STATE:?}"
touch "$state"
tab=$'\t'

if [ "${1:-}" = "s3" ] && [ "${2:-}" = "cp" ]; then
  src="$3"; dest="$4"
  [ -s "$src" ] || { echo "fake aws: $src is missing" >&2; exit 1; }
  key="${dest#s3://}"; key="${key#*/}"
  { grep -v "^${key}${tab}" "$state" || true; printf '%s\t%s\n' "$key" "${FAKE_CLOCK:?}"; } > "$state.tmp"
  mv "$state.tmp" "$state"
  if [ -n "${S3_LOG:-}" ]; then echo "$key" >> "$S3_LOG"; fi
  exit 0
fi

[ "${1:-} ${2:-}" = "s3api list-objects-v2" ] || { echo "fake aws: unsupported command: $*" >&2; exit 3; }
prefix=""; q=""; o=""
while [ $# -gt 0 ]; do
  case "$1" in --prefix) prefix="$2"; shift ;; --query) q="$2"; shift ;; --output) o="$2"; shift ;; esac
  shift
done
[ "$o" = "text" ] || { echo "fake aws: only --output text is faked" >&2; exit 3; }

listing() { # the objects under the prefix, sorted by key like S3
  while IFS="$tab" read -r k lm; do
    case "$k" in "$prefix"*) printf '%s\t%s\n' "$k" "$lm" ;; esac
  done < "$state" | LC_ALL=C sort
}

# shellcheck disable=SC2016  # backticks are JMESPath literals
count_q='length(Contents || `[]`)'
# shellcheck disable=SC2016
newest_q='sort_by(Contents || `[]`, &LastModified)[-1].LastModified'
exact_re="^Contents\[\?Key=='([^']*)'\]\.LastModified \| \[0\]$"

if [ "$q" = "$count_q" ]; then
  listing | grep -c . || true
elif [ "$q" = "$newest_q" ]; then
  lm=$(listing | LC_ALL=C sort -t "$tab" -k2 | tail -1 | cut -f2)
  echo "${lm:-None}"
elif [[ "$q" =~ $exact_re ]]; then
  want="${BASH_REMATCH[1]}"
  lm=$(listing | awk -F "$tab" -v k="$want" '$1 == k { print $2 }')
  echo "${lm:-None}"
else
  echo "fake aws: unsupported query: $q" >&2
  exit 3
fi
