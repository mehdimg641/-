#!/usr/bin/env bash
# Run by a cPanel cron job on the host. Pulls the deploy-php branch and, when it changed, copies
# site/ into the document root. api/config.php is never in the branch, so it is never touched.
# Usage: bash update.sh /home/USER/inbox.sepandsteel.com

# Everything lives in main() so bash has read the whole script before `git reset` rewrites it.
main() {
  set -eu
  local dest="${1:-}" repo
  repo="$(cd "$(dirname "$0")" && pwd)"
  export PATH="$PATH:/usr/local/cpanel/3rdparty/bin"

  if [ -z "$dest" ] || [ ! -f "$dest/api/config.php" ]; then
    echo "$(date '+%F %T') ✗ '$dest' has no api/config.php: install the site there first (README-PHP-FA.md)"
    return 1
  fi
  # A slow run must not overlap the next cron tick.
  # A lock left by a killed run expires after 30 minutes.
  find "$repo/.lock" -maxdepth 0 -mmin +30 -exec rmdir {} \; 2>/dev/null || true
  mkdir "$repo/.lock" 2>/dev/null || return 0
  trap "rmdir '$repo/.lock'" EXIT

  cd "$repo"
  git fetch -q origin deploy-php
  local new old
  new="$(git rev-parse origin/deploy-php)"
  old="$(cat .deployed 2>/dev/null || true)"
  [ "$new" = "$old" ] && return 0
  git reset -q --hard "$new"
  [ -f site/index.html ] && [ -f site/api/trpc.php ] || { echo "$(date '+%F %T') ✗ incomplete build in $new"; return 1; }

  # New assets first, then the pages that reference them, then drop assets nothing uses any more.
  mkdir -p "$dest/assets"
  if command -v rsync >/dev/null; then
    rsync -a site/assets/ "$dest/assets/"
    rsync -a --exclude /assets --exclude /api/config.php site/ "$dest/"
    rsync -a --delete site/assets/ "$dest/assets/"
  else
    cp -R site/assets/. "$dest/assets/"
    (cd site && find . -path ./assets -prune -o -type f -print | while read -r f; do mkdir -p "$dest/$(dirname "$f")"; cp "$f" "$dest/$f"; done)
    for f in "$dest"/assets/*; do [ -e "site/assets/${f##*/}" ] || rm -f "$f"; done
  fi

  echo "$new" > .deployed
  echo "$(date '+%F %T') ✓ deployed $(sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p' site/version.json) ($new)"
}
main "$@"
exit
