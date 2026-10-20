# به‌روزرسانی خودکار Sepand Inbox روی هاست (cPanel، بدون Node.js)

شاخهٔ `deploy-php` همیشه آخرین نسخهٔ آمادهٔ سایت را دارد (`site/` = محتوای پوشهٔ سایت).
یک Cron Job در cPanel هر ۱۰ دقیقه این شاخه را از GitHub می‌گیرد و اگر نسخهٔ تازه‌ای آمده بود،
آن را در پوشهٔ سایت کپی می‌کند. `api/config.php` داخل این شاخه نیست و هیچ‌وقت عوض نمی‌شود.

## راه‌اندازی (یک بار)
1. مسیر پوشهٔ سایت را پیدا کنید: cPanel ← **Domains** ← ستون Document Root روبه‌روی
   `inbox.sepandsteel.com` (مثلاً `/home/USER/inbox.sepandsteel.com`).
2. cPanel ← **Cron Jobs**:
   - Common Settings: **Once Per Ten Minutes** (`*/10 * * * *`)
   - Command (مسیر خط آخر را با مسیر مرحلهٔ ۱ عوض کنید):

```
{ PATH="$PATH:/usr/local/cpanel/3rdparty/bin"; [ -d "$HOME/sepand-deploy" ] || git clone -q -b deploy-php --single-branch https://github.com/mehdimg641/-.git "$HOME/sepand-deploy"; bash "$HOME/sepand-deploy/update.sh" "$HOME/inbox.sepandsteel.com"; } >> "$HOME/sepand-deploy.log" 2>&1
```

3. ۱۰ دقیقه بعد فایل `sepand-deploy.log` را در پوشهٔ اصلی هاست (File Manager ← Home) باز کنید.
   خط `✓ deployed …` یعنی کار می‌کند. نسخهٔ فعلی سایت: `https://inbox.sepandsteel.com/version.json`

## اگر مخزن GitHub خصوصی است
هاست برای گرفتن نسخه‌ها یک توکن **فقط‌خواندنی** لازم دارد:
1. GitHub ← Settings ← Developer settings ← Personal access tokens ← **Fine-grained tokens** ←
   Generate new token:
   - Repository access: **Only select repositories** ← `mehdimg641/-`
   - Permissions ← Repository permissions ← **Contents: Read-only** (بقیه را دست نزنید)
   - Expiration: مثلاً یک سال (قبل از انقضا یک توکن تازه بسازید و فایل را عوض کنید)
2. cPanel ← File Manager ← پوشهٔ Home (نه داخل پوشهٔ سایت) ← **+ File** با نام
   `sepand-github-token` ← Edit ← فقط خود توکن را paste و ذخیره کنید ←
   راست‌کلیک ← Change Permissions ← `600`.
3. حالا مخزن را خصوصی کنید. توکن را هیچ‌جای دیگری (چت، ایمیل، پیام) نفرستید.

`update.sh` توکن را فقط وقتی git می‌خواهد از همین فایل می‌خواند؛ در دستور Cron یا تنظیمات git
ذخیره نمی‌شود.

## خطاهای رایج
- `Authentication failed` یا `Repository not found` بعد از خصوصی کردن مخزن: فایل
  `sepand-github-token` نیست، توکن منقضی شده، یا دسترسی Contents: Read-only به این مخزن را ندارد.
- `has no api/config.php`: مسیر خط آخر اشتباه است؛ باید پوشه‌ای باشد که سایت قبلاً در آن نصب شده.
- `git: command not found` یا خطای اتصال به github.com: هاست به GitHub دسترسی ندارد یا git
  ندارد؛ به پشتیبانی هاست بگویید یا همان روش آپلود زیپ را ادامه دهید.

برای توقف، Cron Job را در cPanel حذف کنید.

## سمت توسعه
`pnpm publish:deploy` (اسکریپت `scripts/publish-deploy-branch.sh`) بسته را می‌سازد و روی شاخهٔ
`deploy-php` منتشر می‌کند.
