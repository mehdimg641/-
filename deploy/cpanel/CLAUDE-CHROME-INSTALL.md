# Finish installing Sepand Inbox on cPanel (inbox.sepandsteel.com) with Claude in Chrome

Use **Claude in Chrome** to finish installing the Sepand Inbox dashboard on my cPanel hosting. I am already signed in to cPanel (and to developers.facebook.com) in Chrome. Talk to me in Persian.

## Background
- Repo: `mehdimg641/-` (GitHub). The package is built by `pnpm package:cpanel`. The full Persian install guide is `README-DEPLOY-FA.md`, which is also inside the zip.
- I have **already uploaded and extracted** `sepand-inbox-cpanel.zip` on the host, but **into the public document root of the subdomain `inbox.sepandsteel.com`**. Right now `https://inbox.sepandsteel.com/` only shows a LiteSpeed "Index of /" listing (`database/`, `dist/`, an empty `sepand-inbox/`, `app.cjs`, `package.json`), and `/api/...` returns 404. No Node.js app has been created yet. The package contains:
  - `app.cjs`: the startup file
  - `dist/`: the server and the dashboard
  - `database/schema.sql`
  - `.env.example`: lists every setting
  - `package.json`: has no dependencies
- The server is a single self-contained bundle. **No `npm install` is needed. Do not click "Run NPM Install".**
- The target is **`https://inbox.sepandsteel.com`** (the subdomain already exists and has SSL). Do not touch the main site on `sepandsteel.com`. The Meta webhook path is `/api/meta/webhook`.

## Ground rules
- Work in new tabs in my existing Chrome sessions. If a page asks for a login, stop and ask me to log in. Never type my cPanel, hosting or Facebook passwords for me.
- Generate secrets locally with `openssl rand -hex 32` (or similar) and enter them **directly into cPanel fields**. Never write secrets into chat, files, commits or screenshots you send me. The one exception is the dashboard admin password: show it to me **once**, so I can save it in my password manager.
- Before anything destructive or hard to undo, stop and ask me. That includes replacing an existing website, deleting files or databases, and changing DNS.
- Verify each step before moving on. If something fails 2–3 times, stop and tell me what you tried.
- Avoid clicking things that open browser confirm dialogs unless necessary, and warn me first.

## Steps
1. **Move the files out of the public folder.**
   - In cPanel → Domains, find the document root of `inbox.sepandsteel.com`; it is often `/home/<user>/inbox.sepandsteel.com` or `/home/<user>/public_html/inbox`.
   - In File Manager, create `/home/<user>/sepand-inbox`, next to `public_html` and not inside it.
   - Move `app.cjs`, `package.json`, `dist/` and `database/` from the subdomain's document root into it.
   - Delete the empty `sepand-inbox/` folder that is left in the document root.
   - Leave the document root empty. Setup Node.js App writes its own `.htaccess` there.
2. **Check the files.** Confirm `/home/<user>/sepand-inbox/app.cjs` and `/home/<user>/sepand-inbox/dist/index.js` (about 3.5 MB) exist. Also confirm `https://inbox.sepandsteel.com/` no longer lists them.
   - If cPanel has no **Setup Node.js App** at all, stop and tell me. The host (HostIran) would then have to enable Node.js first.
3. **Database.**
   - cPanel → MySQL® Databases: create a database (e.g. `<prefix>_sepand`) and a user (e.g. `<prefix>_sepand`) with a generated strong password.
   - Add the user to the database with **ALL PRIVILEGES**.
   - Note the full prefixed names.
4. **Schema.**
   - cPanel → phpMyAdmin → select the new database → Import → choose `sepand-inbox/database/schema.sql` from the server. If phpMyAdmin can only upload from my computer, ask me to pick the file, or download it from File Manager first.
   - Confirm 4 tables exist: `users`, `igEvents`, `replyRules`, `replies`.
5. **Node.js app.**
   - cPanel → Setup Node.js App → Create Application:
     - Node.js version: 18 or higher (prefer 20/22)
     - Application mode: Production
     - Application root: the folder from step 1
     - Application URL: `inbox.sepandsteel.com` (no path)
     - Application startup file: `app.cjs`
   - Add these environment variables:
     - `NODE_ENV=production`
     - `ADMIN_USERNAME`: ask me, default `admin`
     - `ADMIN_PASSWORD`: ask me, or generate 20+ characters and show it to me once
     - `JWT_SECRET`: generated, 64 hex characters
     - `DATABASE_URL=mysql://<dbuser>:<url-encoded password>@localhost:3306/<dbname>`
     - `META_WEBHOOK_VERIFY_TOKEN`: generated
     - `META_AUTO_REPLY=false`
   - Save, then Restart.
6. **SSL.**
   - cPanel → SSL/TLS Status: make sure `inbox.sepandsteel.com` has a valid AutoSSL / Let's Encrypt certificate. Run AutoSSL if needed.
   - Meta only accepts HTTPS webhooks.
7. **Verify the dashboard.**
   - Open `https://inbox.sepandsteel.com/`. A Persian login form "ورود به سپند Inbox" should appear. Log in with the admin credentials.
   - Open the Settings tab (تنظیمات). «پایگاه داده» should say MySQL is connected.
   - If the page shows 503 or errors, read `stderr.log` in the app folder (File Manager) and fix the cause. Usual causes:
     - wrong startup file
     - Node version too old
     - bad `DATABASE_URL` (password not URL-encoded)
   - Also check that `https://inbox.sepandsteel.com/api/meta/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=ok` returns `ok`.
8. **Connect Meta.**
   - Ask me for:
     - `META_APP_SECRET` (Meta app → App settings → Basic)
     - `META_ACCESS_TOKEN` (an Instagram Login token `IGAA…` or a page token `EAA…`)
     - the numeric Instagram professional account id for `INSTAGRAM_ACCOUNT_IDS`
   - Paste them **only** into the cPanel environment variables, then Restart the app.
   - In developers.facebook.com → my app → Webhooks (Instagram product):
     - Callback URL: `https://inbox.sepandsteel.com/api/meta/webhook`
     - Verify token: the same `META_WEBHOOK_VERIFY_TOKEN`
     - Verify and save, then subscribe to the **comments** and **messages** fields.
9. **Final check.**
   - Ask me to post a test comment or DM to @sepandsteel.
   - Confirm it shows up in the inbox (صندوق ورودی) and a draft shows up in اتوماسیون → صف تأیید.
   - Do not approve or send anything without my say-so.

## Done means
- The dashboard is live at `https://inbox.sepandsteel.com` and the "Index of /" listing is gone.
- I can log in.
- The database is connected.
- The Meta webhook is verified and receiving events.
- Auto-reply is still off.

Finish with a short Persian summary: what you did, the final URLs, and anything left for me. Leave out secrets, except the admin password if I haven't saved it yet. Close the tabs you opened.
