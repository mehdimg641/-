# Sepand Inbox

داشبورد فارسی (RTL) برای مدیریت کامنت‌ها و دایرکت‌های اینستاگرام `@sepandsteel`: دریافت امن رویدادها از Meta، ساخت پیش‌نویس پاسخ با قوانین قابل‌تنظیم، صف تأیید اپراتور و ارسال پاسخ.

## جریان کار

1. Meta رویداد کامنت یا دایرکت را به `POST /api/meta/webhook` می‌فرستد.
2. امضای `X-Hub-Signature-256` با `META_APP_SECRET` روی بایت‌های خام بررسی می‌شود؛ درخواست بدون امضای معتبر با ۴۰۱ رد می‌شود.
3. کامنت‌های خود صفحه، echo دایرکت‌ها، پیام‌های حذف‌شده، رسیدهای read/delivery و حساب‌های خارج از `INSTAGRAM_ACCOUNT_IDS` نادیده گرفته می‌شوند.
4. رویداد در پایگاه داده ذخیره می‌شود (کلید یکتا روی حساب + نوع + شناسه، پس retryهای Meta تکراری ثبت نمی‌شوند). اگر ذخیره ناموفق باشد ۵۰۳ برمی‌گردد تا Meta دوباره بفرستد.
5. اولین قانون منطبق (به ترتیب اولویت) یک پیش‌نویس پاسخ می‌سازد که در **صف تأیید** داشبورد می‌ماند.
6. اپراتور پیش‌نویس را ویرایش، تأیید و ارسال یا رد می‌کند، یا مستقیم از کادر پاسخ می‌نویسد. خطاهای Meta (مثلاً پنجرهٔ ۲۴ ساعتهٔ دایرکت) ثبت می‌شوند و قابل تلاش مجددند.

ارسال خودکار پیش‌فرض خاموش است. با `META_AUTO_REPLY=true` فقط قوانین با اقدام «ارسال مستقیم» خودکار ارسال می‌شوند؛ قوانین «نیازمند تأیید» (قیمت، تخفیف، قرارداد، تحویل) همیشه منتظر اپراتور می‌مانند.

داشبورد فقط برای کاربران با نقش `admin` باز است. با `AUTH_MODE=local` ورود با `ADMIN_USERNAME` / `ADMIN_PASSWORD` انجام می‌شود (۵ تلاش ناموفق = ۱۵ دقیقه مسدودی)؛ در غیر این صورت ورود Manus استفاده می‌شود و مالک برنامه (`OWNER_OPEN_ID`) admin است.

## راه‌اندازی

```bash
pnpm install
cp .env.example .env   # مقادیر را پر کنید
pnpm db:push           # ساخت جدول‌ها (نیازمند DATABASE_URL)
pnpm dev
```

بدون `DATABASE_URL` برنامه با ذخیره‌سازی موقت در حافظه اجرا می‌شود (برای پیش‌نمایش؛ داده‌ها با ری‌استارت پاک می‌شوند).

### اتصال Meta

1. در برنامهٔ Meta، وب‌هوک اینستاگرام را با آدرس `https://<دامنه>/api/meta/webhook` و همان `META_WEBHOOK_VERIFY_TOKEN` ثبت کنید و فیلدهای `comments` و `messages` را subscribe کنید.
2. `META_ACCESS_TOKEN` را تنظیم کنید. توکن‌های Instagram Login (`IGAA…`) روی `graph.instagram.com` و توکن‌های صفحهٔ Facebook (`EAA…`) روی `graph.facebook.com` استفاده می‌شوند؛ با `META_API_HOST` می‌توانید آن را اجباری کنید.
3. شناسهٔ عددی حساب حرفه‌ای اینستاگرام را در `INSTAGRAM_ACCOUNT_IDS` بگذارید.

توکن و secretها را در فایل commitشده نگذارید؛ در محیط تولید از secret manager میزبان استفاده کنید. access log پراکسی نباید query string درخواست GET وب‌هوک (که verify token دارد) را ثبت کند.

### نصب روی هاست cPanel

`pnpm package:cpanel` فایل `release/sepand-inbox-cpanel.zip` را می‌سازد: سرور با همهٔ وابستگی‌ها در یک فایل، داشبورد با ورود نام کاربری/رمز، و `database/schema.sql`. مراحل نصب در [README-DEPLOY-FA.md](README-DEPLOY-FA.md) است.

## دستورات

| دستور | کاربرد |
| --- | --- |
| `pnpm dev` | سرور توسعه |
| `pnpm test` | آزمون‌ها (vitest) |
| `pnpm check` | بررسی TypeScript |
| `pnpm build` / `pnpm start` | ساخت و اجرای نسخهٔ تولید |
| `pnpm db:push` | تولید و اجرای migrationها |
| `pnpm package:cpanel` | ساخت بستهٔ zip برای cPanel |

## ساختار

- `server/metaWebhook.ts` — مسیر وب‌هوک، بررسی امضا، استخراج رویدادها
- `server/inboxService.ts` — ذخیرهٔ رویداد، ساخت پیش‌نویس، ارسال/رد، ساخت مکالمات و آمار
- `server/replyRules.ts` — موتور قوانین و قوانین پیش‌فرض
- `server/inboxStore.ts` — ذخیره‌سازی MySQL (drizzle) و جایگزین حافظه‌ای
- `server/metaGraph.ts` — فراخوانی Graph API
- `server/routers.ts` — APIهای tRPC (`inbox`, `approvals`, `rules`)
- `drizzle/schema.ts` — جدول‌های `igEvents`, `replyRules`, `replies`
- `client/src/pages/Home.tsx` و `client/src/pages/inbox/*` — داشبورد
