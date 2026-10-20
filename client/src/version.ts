declare const __APP_BUILD__: { version: string; commit: string; builtAt: string };

/** This page's build, baked in by Vite. */
export const APP_BUILD = __APP_BUILD__;

/** What changed, newest first; shown in Settings. */
export const CHANGELOG: Array<{ version: string; items: string[] }> = [
  { version: "1.5.1", items: ["صفحه‌های حریم خصوصی و حذف اطلاعات برای Live کردن برنامهٔ Meta (/privacy.html و /data-deletion.html)"] },
  {
    version: "1.5.0",
    items: [
      "عیب‌یابی اتصال Meta در تنظیمات: گزارش درخواست‌های وبهوک و وضعیت اشتراک رویدادها",
      "دکمهٔ فعال‌سازی دریافت کامنت و دایرکت (subscribed_apps)",
      "نمایش نسخهٔ برنامه و هشدار وقتی نسخهٔ تازه‌تری روی سرور نصب شده",
      "تعداد کامنت‌های هر پست در اینستاگرام کنار تعداد کامنت‌های واردشده",
    ],
  },
  { version: "1.4.1", items: ["دریافت کامنت‌هایی که اینستاگرام بدون مشخصات نویسنده می‌دهد", "صفحه دیگر در مرورگر کش نمی‌شود"] },
  { version: "1.4.0", items: ["صفحهٔ پست‌ها، پاسخ کامنت + دایرکت بر اساس کلمه", "کتابخانهٔ قالب پاسخ", "به‌روزرسانی خودکار هاست از GitHub"] },
  { version: "1.3.0", items: ["نسخهٔ PHP برای هاست بدون Node.js", "اتصال اینستاگرام از داخل داشبورد"] },
];
