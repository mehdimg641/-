#!/usr/bin/env bash
# Builds the PHP package and publishes it to the deploy-php branch, which the host pulls every few
# minutes (deploy/php-autodeploy/README.md). Branch layout: site/ (the document root), update.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH=deploy-php
REMOTE="${DEPLOY_REMOTE:-origin}"
cd "$ROOT"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ Commit your changes first: the deployed build is labelled with the current commit." >&2
  exit 1
fi
SRC="$(git rev-parse --short HEAD)"

bash scripts/package-php.sh

STAGE="$(mktemp -d)"
INDEX="$(mktemp)"
trap 'rm -rf "$STAGE" "$INDEX"' EXIT
cp -R release/sepand-inbox-php "$STAGE/site"
rm -f "$STAGE/site/.gitkeep"
printf '{ "version": "%s", "commit": "%s", "builtAt": "%s" }\n' "$(node -p "require('./package.json').version")" "$SRC" "$(date -u +%FT%TZ)" > "$STAGE/site/version.json"
cp deploy/php-autodeploy/update.sh deploy/php-autodeploy/README.md "$STAGE/"

parent=""
if git fetch -q "$REMOTE" "$BRANCH" 2>/dev/null; then parent="$(git rev-parse FETCH_HEAD)"; fi

rm -f "$INDEX"
tree="$(cd "$STAGE" && export GIT_DIR="$ROOT/.git" GIT_WORK_TREE="$STAGE" GIT_INDEX_FILE="$INDEX" && git add -A . && git write-tree)"
# version.json changes on every build; compare everything else to skip no-op deploys.
if [ -n "$parent" ] && [ -z "$(git diff --name-only "$parent" "$tree" -- . ':!site/version.json')" ]; then
  echo "✓ $BRANCH already has this build"
  exit 0
fi

msg="Deploy $SRC from $(git rev-parse --abbrev-ref HEAD)

${DEPLOY_TRAILERS:-}"
commit="$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "$msg")"
git push -q "$REMOTE" "$commit:refs/heads/$BRANCH"
echo "✓ Published $SRC to $BRANCH ($commit)"
