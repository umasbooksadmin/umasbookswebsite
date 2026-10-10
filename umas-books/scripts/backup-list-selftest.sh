#!/usr/bin/env bash
# Offline test of the JMESPath expressions the backup workflows pass to
# `aws s3api list-objects-v2 --query ...`. The AWS CLI uses the python
# `jmespath` library, so the same library is run here on sample responses,
# including the empty-folder one ({"Contents": null}) that once broke the
# freshness check with "sort_by(): invalid type for value: None".
#
#   bash umas-books/scripts/backup-list-selftest.sh
#
# Needs python3 with `jmespath` (pip install jmespath, or inside a venv); exit 2
# if it is missing. Touches no network, no Backblaze, no AWS credentials.
# The Node test test/unit/backupWorkflows.test.js runs it when jmespath exists.
set -euo pipefail
command -v python3 >/dev/null || { echo "python3 not found"; exit 2; }
PY="${PYTHON:-python3}"
"$PY" -c 'import jmespath' 2>/dev/null || { echo "python module jmespath not found (pip install jmespath)"; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wf="$here/../../.github/workflows"

"$PY" - "$wf" <<'PYEOF'
import sys, re, json, jmespath

wf = sys.argv[1]
fails = []

def expr_of(name, needle):
    """Every --query '<expr>' in the workflow that mentions `needle`."""
    text = open(f"{wf}/{name}").read()
    return [m for m in re.findall(r"--query '([^']*)'", text) if needle in m]

# 1. Every sort_by(Contents ...) query in every workflow is null-safe.
for name in ("backup-freshness.yml", "backup-restore-test.yml", "nightly-db-backup.yml"):
    for q in expr_of(name, "sort_by"):
        if "Contents || `[]`" not in q:
            fails.append(f"{name}: query is not null-safe: {q}")

empty = {"Contents": None}          # what the API returns for an empty folder
absent = {}                          # some servers omit the key
one = {"Contents": [{"Key": "a", "LastModified": "2026-10-01T03:00:00Z", "Size": 5}]}
many = {"Contents": [
    {"Key": "b", "LastModified": "2026-10-02T03:00:00Z", "Size": 7},
    {"Key": "a", "LastModified": "2026-10-01T03:00:00Z", "Size": 5},
    {"Key": "c", "LastModified": "2026-10-03T03:00:00Z", "Size": 9},
]}

def run(q, data):
    return jmespath.search(q, data)

queries = {}
for name in ("backup-freshness.yml", "backup-restore-test.yml", "nightly-db-backup.yml"):
    for q in expr_of(name, "sort_by"):
        queries.setdefault(q, []).append(name)

if not queries:
    fails.append("no sort_by queries found in the workflows")

for q, names in queries.items():
    for label, data in (("null Contents", empty), ("missing Contents", absent)):
        try:
            r = run(q, data)
        except Exception as e:  # noqa
            fails.append(f"{q} raised on {label}: {e}")
            continue
        if r is not None:
            fails.append(f"{q} on {label}: expected null (aws prints None), got {r!r}")
    if run(q, one) is None:
        fails.append(f"{q} returned null for a one-object folder")

# 2. The expressions pick the right object.
newest = "sort_by(Contents || `[]`, &LastModified)[-1].[Key,LastModified,Size]"
oldest = "sort_by(Contents || `[]`, &LastModified)[0].LastModified"
if run(newest, many) != ["c", "2026-10-03T03:00:00Z", 9]:
    fails.append("newest-object expression picked the wrong object")
if run(oldest, many) != "2026-10-01T03:00:00Z":
    fails.append("oldest-object expression picked the wrong object")
try:
    jmespath.search("sort_by(Contents, &LastModified)[-1]", empty)
    fails.append("sanity: the OLD expression was expected to raise on null Contents")
except Exception:
    pass  # confirms the self-test reproduces the original bug

if fails:
    print("SELFTEST FAILED:")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print(f"OK: {len(queries)} distinct sort_by queries are null-safe and pick the right object.")
PYEOF
