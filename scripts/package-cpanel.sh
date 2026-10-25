#!/usr/bin/env bash
# Builds release/sepand-inbox-cpanel.zip: a self-contained install for cPanel "Setup Node.js App".
# The server is bundled with all its dependencies, so the host needs no npm install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release/sepand-inbox"
ZIP="$ROOT/release/sepand-inbox-cpanel.zip"
cd "$ROOT"

rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT/dist" "$OUT/database"

echo "→ Building client"
NODE_ENV=production VITE_AUTH_MODE=local pnpm exec vite build --outDir "$OUT/dist/public" --emptyOutDir

echo "→ Bundling server"
pnpm exec esbuild server/_core/index.ts \
  --platform=node --bundle --format=esm --target=node18 \
  --external:vite --external:../../vite.config \
  --banner:js="import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);" \
  --outfile="$OUT/dist/index.js" --log-level=warning

echo "→ Writing schema.sql"
{
  echo "-- Sepand Inbox database schema. Import once into an empty database (phpMyAdmin → Import)."
  echo "SET NAMES utf8mb4;"
  for f in drizzle/[0-9]*.sql; do
    echo
    echo "-- $(basename "$f")"
    # Make drizzle's output importable on MySQL 5.7+ / MariaDB 10.2+ as well as MySQL 8:
    # - plain statements instead of drizzle's separators
    # - CURRENT_TIMESTAMP instead of the MySQL-8-only expression default (now())
    # - explicit NULL on nullable timestamps (5.7 otherwise makes them NOT NULL)
    # - utf8mb4 tables so Persian text survives
    sed -e 's/--> statement-breakpoint//g' \
        -e 's/DEFAULT (now())/DEFAULT CURRENT_TIMESTAMP/g' \
        -e 's/^\(\t`[A-Za-z]*` timestamp\),$/\1 NULL,/' \
        -e 's/^);$/) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;/' "$f"
  done
} > "$OUT/database/schema.sql"

cp deploy/cpanel/app.cjs deploy/cpanel/package.json deploy/cpanel/.env.example "$OUT/"
cp README-DEPLOY-FA.md "$OUT/"

echo "→ Zipping"
(cd "$ROOT/release" && zip -qr "$(basename "$ZIP")" "$(basename "$OUT")")
echo "✓ $ZIP ($(du -h "$ZIP" | cut -f1))"
