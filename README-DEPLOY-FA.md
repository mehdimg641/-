# راهنمای نصب Sepand Inbox روی هاست cPanel

این بسته برای اجرا روی `https://sepandsteel.com` با بخش **Setup Node.js App** در cPanel (یا معادل آن در DirectAdmin) آماده شده است. سرور با همهٔ وابستگی‌هایش در یک فایل ساخته شده؛ **نیازی به `npm install` نیست.**

> ⚠️ اگر الان سایت اصلی شرکت روی `sepandsteel.com` است، نصب روی ریشهٔ دامنه آن را جایگزین می‌کند. در این صورت یک زیردامنه مثل `inbox.sepandsteel.com` بسازید و در همهٔ مراحل زیر به‌جای `sepandsteel.com` از آن استفاده کنید.

## محتوای بسته

| مسیر | توضیح |
| --- | --- |
| `app.cjs` | فایل شروع برنامه (Application startup file) |
| `dist/` | سرور و فایل‌های داشبورد |
| `database/schema.sql` | ساختار پایگاه داده |
| `.env.example` | الگوی تنظیمات |
| `package.json` | مشخصات برنامه (بدون وابستگی) |

## ۱. پایگاه داده

1. cPanel → **MySQL® Databases**: یک پایگاه داده (مثلاً `sepand`) و یک کاربر بسازید و کاربر را با **ALL PRIVILEGES** به پایگاه داده اضافه کنید.
2. cPanel → **phpMyAdmin** → پایگاه داده را انتخاب کنید → **Import** → فایل `database/schema.sql` را انتخاب و اجرا کنید.
   این کار فقط یک بار و روی پایگاه دادهٔ خالی انجام می‌شود. جدول‌ها با `utf8mb4` ساخته می‌شوند تا متن فارسی درست ذخیره شود.

## ۲. بارگذاری فایل‌ها

1. cPanel → **File Manager** → در پوشهٔ خانه (نه داخل `public_html`) پوشهٔ `sepand-inbox` بسازید.
2. فایل zip را آنجا Upload و **Extract** کنید تا `app.cjs` مستقیماً داخل `~/sepand-inbox` باشد.

## ۳. ساخت برنامهٔ Node.js

cPanel → **Setup Node.js App** → **Create Application**:

| فیلد | مقدار |
| --- | --- |
| Node.js version | ۱۸ یا بالاتر (ترجیحاً ۲۰ یا ۲۲) |
| Application mode | Production |
| Application root | `sepand-inbox` |
| Application URL | `sepandsteel.com` (ریشه، بدون مسیر) |
| Application startup file | `app.cjs` |

سپس در بخش **Environment variables** این متغیرها را اضافه کنید (توضیح هر کدام در `.env.example` هست):

| متغیر | مقدار |
| --- | --- |
| `NODE_ENV` | `production` |
| `ADMIN_USERNAME` | نام کاربری ورود به داشبورد |
| `ADMIN_PASSWORD` | رمز طولانی و یکتا (حداقل ۱۰ نویسه) |
| `JWT_SECRET` | رشتهٔ تصادفی ۳۲ نویسه یا بیشتر |
| `DATABASE_URL` | `mysql://کاربر:رمز@localhost:3306/نام_پایگاه_داده` |
| `META_APP_SECRET` | App secret برنامهٔ Meta |
| `META_WEBHOOK_VERIFY_TOKEN` | رشتهٔ تصادفی دلخواه (همان را در Meta وارد می‌کنید) |
| `META_ACCESS_TOKEN` | توکن دسترسی اینستاگرام |
| `INSTAGRAM_ACCOUNT_IDS` | شناسهٔ عددی حساب حرفه‌ای اینستاگرام |
| `META_AUTO_REPLY` | `false` |

- اگر رمز پایگاه داده نویسهٔ خاص دارد، در `DATABASE_URL` آن را کدگذاری کنید (مثلاً `@` → `%40`، `#` → `%23`).
- برای ساخت رشتهٔ تصادفی می‌توانید در Terminal سی‌پنل بزنید: `openssl rand -hex 32`
- دکمهٔ **Run NPM Install** را **نزنید**؛ لازم نیست.

**Save** و بعد **Restart** را بزنید.

## ۴. SSL

cPanel → **SSL/TLS Status** → برای `sepandsteel.com` گواهی **AutoSSL** (یا Let's Encrypt) را فعال کنید. Meta فقط آدرس HTTPS را برای وب‌هوک می‌پذیرد و کوکی ورود هم روی HTTPS امن است.

## ۵. بررسی

1. `https://sepandsteel.com` را باز کنید؛ صفحهٔ ورود باید نمایش داده شود. با `ADMIN_USERNAME` و `ADMIN_PASSWORD` وارد شوید.
2. در داشبورد → **تنظیمات**: «پایگاه داده: MySQL متصل است» و «وب‌هوک و امضا» باید روشن باشند.
3. پس از ۵ تلاش ناموفق ورود، آن IP به مدت ۱۵ دقیقه مسدود می‌شود.

## ۶. اتصال Meta

در **developers.facebook.com** → برنامهٔ شما → **Webhooks** (محصول Instagram):

- Callback URL: `https://sepandsteel.com/api/meta/webhook`
- Verify token: همان مقدار `META_WEBHOOK_VERIFY_TOKEN`
- فیلدهای **comments** و **messages** را Subscribe کنید.

با یک کامنت یا دایرکت آزمایشی، پیام باید در صندوق ورودی و پیش‌نویس پاسخ در **اتوماسیون → صف تأیید** ظاهر شود.

## به‌روزرسانی

zip جدید را در همان پوشه Extract کنید (جایگزین فایل‌ها) و در **Setup Node.js App** دکمهٔ **Restart** را بزنید. اگر نسخهٔ جدید تغییر پایگاه داده داشته باشد، در یادداشت انتشار گفته می‌شود.

## رفع اشکال

- **صفحه باز نمی‌شود / خطای 503:** در Setup Node.js App مسیر لاگ (`stderr.log` در پوشهٔ برنامه) را ببینید. رایج‌ترین علت، نسخهٔ پایین Node یا اشتباه بودن startup file است.
- **«ورود پیکربندی نشده»:** `ADMIN_USERNAME`، `ADMIN_PASSWORD` (حداقل ۱۰ نویسه) و `JWT_SECRET` را تنظیم و Restart کنید.
- **«ذخیره موقت (بدون DB)»:** `DATABASE_URL` تنظیم نشده یا اشتباه است؛ داده‌ها با هر Restart پاک می‌شوند.
- **Meta وب‌هوک را تأیید نمی‌کند:** SSL فعال باشد، Verify token دقیقاً یکسان باشد و آدرس با `/api/meta/webhook` تمام شود.
- **متن فارسی به‌صورت `????` ذخیره می‌شود:** پایگاه داده باید utf8mb4 باشد؛ `schema.sql` را دوباره روی پایگاه دادهٔ خالی Import کنید.
