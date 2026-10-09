#!/usr/bin/env bash
# Client-side encryption of a database dump with age (https://age-encryption.org),
# used by .github/workflows/nightly-db-backup.yml and by
# umas-books/scripts/backup-encrypt-selftest.sh (which tests THIS file).
#
#   BACKUP_AGE_RECIPIENT=age1... encrypt-dump.sh <dump file>
#       writes <dump file>.age, checks it, and deletes the plaintext <dump file>
#   BACKUP_AGE_RECIPIENT=age1... encrypt-dump.sh --check
#       only validates the recipient setting (exit 0 = fine)
#
# BACKUP_AGE_RECIPIENT holds one or more age PUBLIC keys ("age1..."), separated by
# spaces, commas or new lines. Only the public key is ever needed to encrypt: the
# private key (identity) stays with the owner and is needed only to restore.
set -euo pipefail

MAGIC="age-encryption.org/v1"

recipients=()
parse_recipients() {
  local raw="${BACKUP_AGE_RECIPIENT:-}" word
  raw="${raw//,/ }"
  # shellcheck disable=SC2086  # word splitting on whitespace is the point
  for word in $raw; do
    # age1 + bech32 data (x25519 keys are 62 characters; post-quantum ones are longer).
    if [[ ! "$word" =~ ^age1[0-9a-z]{50,}$ ]]; then
      echo "::error::BACKUP_AGE_RECIPIENT contains something that is not an age public key (a public key starts with 'age1'). Never put the PRIVATE key (starts with AGE-SECRET-KEY-) here." >&2
      return 1
    fi
    recipients+=("$word")
  done
  if [ "${#recipients[@]}" -eq 0 ]; then
    echo "::error::BACKUP_AGE_RECIPIENT is empty." >&2
    return 1
  fi
}

parse_recipients

if [ "${1:-}" = "--check" ]; then
  echo "${#recipients[@]}"
  exit 0
fi

in="${1:?usage: encrypt-dump.sh <dump file> | --check}"
out="$in.age"
test -s "$in" || { echo "::error::$in is missing or empty." >&2; exit 1; }

args=()
for r in "${recipients[@]}"; do args+=(-r "$r"); done

if ! age "${args[@]}" -o "$out" "$in"; then
  rm -f "$out"
  echo "::error::age failed to encrypt $in." >&2
  exit 1
fi

# Verify what will be uploaded: non-empty, an age file, and not the plaintext.
test -s "$out" || { echo "::error::$out is missing or empty." >&2; exit 1; }
if [ "$(head -c "${#MAGIC}" "$out")" != "$MAGIC" ]; then
  echo "::error::$out does not start with the age header; refusing to upload it." >&2
  exit 1
fi
if cmp -s "$in" "$out"; then
  echo "::error::the encrypted file is identical to the plaintext." >&2
  exit 1
fi
rm -f "$in"
echo "Encrypted for ${#recipients[@]} recipient(s): $(du -h "$out" | cut -f1) ($out)"
