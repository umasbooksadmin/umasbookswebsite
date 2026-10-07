#!/usr/bin/env bash
# Decides how much of CI a pull request needs, to save GitHub Actions minutes
# (the repository is private: 2,000 free minutes a month, and a full CI run is
# about 20 billed minutes). Writes two outputs for the calling job:
#
#   docs_only     "true" when EVERY changed file is documentation (docs/**, *.md)
#   smoke_needed  "true" when a changed file can change what the site serves or how
#                 it is built (umas-books/src, views, public, migrations, scripts,
#                 e2e, package files, the root marketing pages and assets, and
#                 anything under .github/)
#
# It never makes a required check skipped or pending: the jobs ALWAYS run and
# report success; they only skip their slow steps inside (see ci.yml). On any
# doubt (not a pull request, no file list, git error) everything runs.
#
# The pull_request checkout is the merge commit of the PR into main, so
# HEAD^1 is the main tip and `git diff HEAD^1 HEAD` is exactly the PR's changes
# (needs fetch-depth: 2). CHANGED_FILES (newline separated) overrides the git
# lookup: used by test/unit/ciChanges.test.js.
set -u

out="${GITHUB_OUTPUT:-/dev/stdout}"
emit() { echo "docs_only=$1" >> "$out"; echo "smoke_needed=$2" >> "$out"; echo "changes: docs_only=$1 smoke_needed=$2"; }

if [ -z "${CHANGED_FILES:-}" ]; then
  if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]; then
    echo "Not a pull request (${GITHUB_EVENT_NAME:-unknown}): running everything."
    emit false true
    exit 0
  fi
  CHANGED_FILES=$(git diff --name-only HEAD^1 HEAD 2>/dev/null) || CHANGED_FILES=""
fi

if [ -z "$CHANGED_FILES" ]; then
  echo "No file list available: running everything."
  emit false true
  exit 0
fi

docs_only=true
smoke_needed=false
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    docs/*|*.md) ;;
    *) docs_only=false ;;
  esac
  case "$f" in
    umas-books/src/*|umas-books/views/*|umas-books/public/*|umas-books/migrations/*|umas-books/scripts/*|umas-books/e2e/*|umas-books/package.json|umas-books/package-lock.json) smoke_needed=true ;;
    assets/*|assets-src/*|render.yaml|.github/*) smoke_needed=true ;;
    */*) ;;
    *.html|*.png|*.jpg|*.svg|*.ico|*.json|*.txt|*.xml) smoke_needed=true ;; # root marketing pages and files the app serves
  esac
done <<< "$CHANGED_FILES"

emit "$docs_only" "$smoke_needed"
