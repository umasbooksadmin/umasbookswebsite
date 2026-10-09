#!/usr/bin/env bash
# Dry run of the backup encryption: creates a dummy dump, encrypts it with
# .github/scripts/encrypt-dump.sh (the very script the nightly workflow runs) for
# a freshly generated age key, decrypts it and compares. Touches no database, no
# Backblaze, no GitHub. Needs `age` and `age-keygen` on PATH (brew install age).
#
#   bash umas-books/scripts/backup-encrypt-selftest.sh
#
# Not run in CI (the runner has no age); the Node test
# test/unit/backupEncryption.test.js runs it automatically when age is installed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../../.github/scripts/encrypt-dump.sh"
command -v age >/dev/null && command -v age-keygen >/dev/null || { echo "age / age-keygen not found (brew install age)"; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

fail() { echo "SELFTEST FAILED: $*"; exit 1; }

# 1. Two key pairs: the real one and a wrong one.
age-keygen -o id.txt 2> pub.txt
age-keygen -o wrong-id.txt 2>/dev/null
RECIP="$(sed -n 's/^Public key: //p' pub.txt)"
[ -n "$RECIP" ] || fail "no public key generated"

# 2. A dummy "dump": pg_dump custom-format magic plus random bytes, with a marker
#    that must NOT be visible in the encrypted file.
{ printf 'PGDMP'; printf 'MARKER-member-email@example.org'; head -c 2000000 /dev/urandom; } > umas_books_full_test.dump
cp umas_books_full_test.dump original.dump

# 3. Encrypt with the workflow's script.
BACKUP_AGE_RECIPIENT="$RECIP" bash "$script" umas_books_full_test.dump
[ -f umas_books_full_test.dump.age ] || fail "no .age file"
[ ! -f umas_books_full_test.dump ] || fail "plaintext was not removed"
[ "$(head -c 21 umas_books_full_test.dump.age)" = "age-encryption.org/v1" ] || fail "no age header"
if grep -aq 'MARKER-member-email' umas_books_full_test.dump.age; then fail "plaintext visible in the encrypted file"; fi

# 4. Decrypt with the right identity and compare.
age -d -i id.txt -o roundtrip.dump umas_books_full_test.dump.age
cmp original.dump roundtrip.dump || fail "decrypted file differs from the original"

# 5. The wrong identity must not decrypt.
if age -d -i wrong-id.txt -o should-not-exist.dump umas_books_full_test.dump.age 2>/dev/null; then fail "wrong key decrypted the file"; fi

# 6. Bad settings are refused (a private key or garbage is never accepted as recipient).
if BACKUP_AGE_RECIPIENT="not-a-key" bash "$script" --check 2>/dev/null; then fail "garbage recipient accepted"; fi
if BACKUP_AGE_RECIPIENT="$(grep -a AGE-SECRET-KEY id.txt)" bash "$script" --check 2>/dev/null; then fail "private key accepted as recipient"; fi
if BACKUP_AGE_RECIPIENT="" bash "$script" --check 2>/dev/null; then fail "empty recipient accepted"; fi
[ "$(BACKUP_AGE_RECIPIENT="$RECIP, $RECIP" bash "$script" --check)" = "2" ] || fail "two recipients not counted"

echo "SELFTEST OK: encrypt -> decrypt round trip, wrong key refused, bad recipients refused."
