#!/usr/bin/env bash
# Builds release/sepand-inbox-php.zip: the dashboard plus a PHP backend for hosts without Node.js.
# Extract the zip straight into the (sub)domain's document root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release/sepand-inbox-php"
ZIP="$ROOT/release/sepand-inbox-php.zip"
cd "$ROOT"

rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"

echo "→ Building dashboard"
NODE_ENV=production VITE_AUTH_MODE=local pnpm exec vite build --outDir "$OUT" --emptyOutDir
rm -rf "$OUT/__manus__"

echo "→ Adding PHP backend"
cp -R deploy/php/. "$OUT/"
cp README-PHP-FA.md "$OUT/README-PHP-FA.md"

echo "→ Checking PHP syntax"
if command -v php >/dev/null; then
  for f in "$OUT"/api/*.php "$OUT"/api/lib/*.php; do php -l "$f" >/dev/null; done
fi

echo "→ Zipping"
(cd "$OUT" && zip -qr "$ZIP" .)
echo "✓ $ZIP ($(du -h "$ZIP" | cut -f1))"
