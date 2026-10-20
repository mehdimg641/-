# نصب Sepand Inbox روی هاست بدون Node.js (نسخهٔ PHP)

این نسخه برای هاست‌های cPanel/DirectAdmin است که Node.js ندارند. داشبورد همان داشبورد است و سرور با **PHP** (۷٫۴ یا بالاتر) و **MySQL** کار می‌کند؛ هر دو تقریباً روی همهٔ هاست‌ها هستند. نیازی به Setup Node.js App، ترمینال یا `npm` نیست.

## ۱. پاک‌سازی پوشهٔ زیردامنه

cPanel → **File Manager** → پوشهٔ زیردامنهٔ `inbox.sepandsteel.com` (معمولاً `public_html/inbox` یا `inbox.sepandsteel.com`):

- هر فایل قبلی (از جمله `app.cjs`، `dist`، `database`، `package.json` و فایل‌های ناشناخته مثل `*.ps1`) را پاک کنید تا پوشه خالی شود.
- اگر قبلاً در **Setup Node.js App** برنامه‌ای برای این زیردامنه ساخته‌اید، آن را حذف کنید.

## ۲. بارگذاری

فایل `sepand-inbox-php.zip` را **مستقیماً داخل همان پوشهٔ زیردامنه** Upload و **Extract** کنید. بعد از Extract باید `index.html`، پوشهٔ `api` و `assets` و فایل `.htaccess` مستقیماً در ریشهٔ پوشه باشند (اگر پوشهٔ تودرتو ساخته شد، محتوایش را یک سطح بالا بیاورید).

> فایل `.htaccess` مخفی است؛ در File Manager از Settings گزینهٔ **Show Hidden Files** را روشن کنید تا ببینید.

## ۳. پایگاه داده

از همان پایگاه دادهٔ MySQL که دارید استفاده کنید (یا در **MySQL® Databases** یکی بسازید و کاربرش را با ALL PRIVILEGES به آن اضافه کنید). **نیازی به Import نیست**؛ جدول‌ها اولین بار خودکار ساخته می‌شوند. اگر پایگاه داده جدولی به نام `users`، `igEvents`، `replyRules`، `replies`، `appSettings` یا `loginFailures` از برنامهٔ دیگری دارد، یک پایگاه دادهٔ جدا بسازید.

## ۴. تنظیمات (فقط یک بار)

در File Manager داخل پوشهٔ `api`:

1. فایل `config.example.php` را **Copy** کنید و نام کپی را `config.php` بگذارید.
2. روی `config.php` → **Edit** و این مقادیر را پر کنید:

| کلید | مقدار |
| --- | --- |
| `db_name` / `db_user` | نام کامل پایگاه داده و کاربر (با پیشوند cPanel) |
| `db_pass` | رمز کاربر پایگاه داده |
| `admin_username` | نام کاربری ورود به داشبورد |
| `admin_password` | رمز طولانی و یکتا (حداقل ۱۰ نویسه) |
| `secret` | رشتهٔ تصادفی حداقل ۳۲ نویسه (مثلاً از یک تولیدکنندهٔ رمز) |

3. **Save**. فایل `config.php` از وب قابل دانلود نیست و با به‌روزرسانی‌ها جایگزین نمی‌شود.

## ۵. ورود و اتصال اینستاگرام

1. `https://inbox.sepandsteel.com` را باز کنید و با `admin_username` / `admin_password` وارد شوید.
2. **تنظیمات** → کارت **«اتصال اینستاگرام»**: Access Token و App Secret را بچسبانید، برای Verify Token «ساخت» را بزنید، **ذخیره** و سپس **تست اتصال** (شناسهٔ حساب خودکار پر می‌شود؛ دوباره ذخیره کنید). مقادیر رمزنگاری‌شده در پایگاه داده ذخیره می‌شوند.
3. در developers.facebook.com → Instagram → **Webhooks**: Callback URL و Verify Token را از همان کارت کپی کنید، **Verify and save** بزنید و فیلدهای **comments** و **messages** را Subscribe کنید.

ارسال خودکار به‌طور پیش‌فرض خاموش است؛ همهٔ پاسخ‌ها در **اتوماسیون → صف تأیید** منتظر تأیید شما می‌مانند.

## بررسی سریع

- `https://inbox.sepandsteel.com/` → صفحهٔ «ورود به سپند Inbox» (نه «Index of /»).
- `https://inbox.sepandsteel.com/api/config.php` → خطای ۴۰۳ (یعنی تنظیمات محافظت شده است).

## رفع اشکال

| نشانه | علت و راه‌حل |
| --- | --- |
| «Index of /» | فایل‌ها در پوشهٔ تودرتو هستند یا `.htaccess` کپی نشده؛ مرحلهٔ ۲ را بررسی کنید |
| «فایل api/config.php وجود ندارد» | مرحلهٔ ۴ |
| «اتصال به پایگاه داده ناموفق بود» | نام/رمز پایگاه داده در `config.php` (با پیشوند cPanel) |
| خطای ۵۰۰ یا «Sepand Inbox needs PHP 7.4» | cPanel → **Select PHP Version** → ۷٫۴ یا بالاتر، با افزونه‌های `pdo_mysql`، `curl`، `openssl`، `mbstring` |
| صفحهٔ ورود می‌آید ولی API خطای ۴۰۴ می‌دهد | بازنویسی آدرس (mod_rewrite) فعال نیست؛ از پشتیبانی هاست بپرسید |
| تست اتصال: «ارتباط سرور با graph.instagram.com برقرار نشد» | هاست اجازهٔ اتصال خروجی به Meta نمی‌دهد؛ از پشتیبانی هاست بخواهید دسترسی به `graph.instagram.com` و `graph.facebook.com` را باز کنند |

خطاهای سرور در فایل `error_log` همان پوشه (یا cPanel → **Errors**) ثبت می‌شوند.
