# Sepand Core

Supabase Edge Function `sepand-core` (project `qzbfsnjekxmvesiekyxc`, eu-central-1): Gemini drafts plus the
Telegram and Bale relay for Sepand Inbox. The inbox host is in Iran and cannot reach Telegram or Gemini, so the
Core talks to them and to the inbox's signed bridges (`telegram-bridge.php`, uploaded by hand and kept in
`inbox/` for reference; `bale-bridge.php`, shipped with the inbox from `deploy/php/`).

- `supabase/functions/sepand-core/` — the deployed function (`index.ts`, `logic.ts`); deploy with verify_jwt off.
- `supabase/migrations/001_outbox_cron.sql` — pg_cron job calling `/outbox` every minute.
- Secrets (names only): `Gemini API Key` or `SEPAND_GEMINI_API_KEY`, `SEPAND_TG_BOT_TOKEN`, `SEPAND_BALE_BOT_TOKEN`,
  `SEPAND_INBOX_URL`, `SEPAND_BRIDGE_SECRET`, `SEPAND_GEMINI_MODEL`, `SEPAND_GEMINI_FALLBACK_MODEL`, optional
  `SEPAND_CORE_SECRET`, `SEPAND_COMPANY_INFO`. `GET /health` shows which are set.
- After a bot token is set or changed, open `GET /telegram/setup` or `GET /bale/setup` once to point its webhook here.

Tests:

```sh
node --test sepand-core/tests/logic.test.ts          # pure logic (Node 22.18+)
node sepand-core/tests/e2e.harness.mjs               # Core ↔ real PHP inbox, messengers and Gemini faked
```

The end-to-end harness needs the PHP backend served locally (`php -S 127.0.0.1:8765` over a copy of `deploy/php`
plus `inbox/telegram-bridge.php`) on a MySQL test database whose config sets
`bridge_secret = bridge-secret-bridge-secret-123456`, and `APPROVE` set to a command that calls `send_reply(<id>, 1)`.
