/** @type {import('next').NextConfig} */
const nextConfig = {
  // صورة صغيرة للإنتاج: Docker بياخد مجلد standalone بس
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // اختبارات المتصفح بتفتح 127.0.0.1؛ بلاها نسخة التطوير بتحجب ملفات الواجهة وما بتشتغل الأزرار
  allowedDevOrigins: ["127.0.0.1"],
  // الإضافة بتنقرأ وقت التشغيل (تنزيل zip والمحددات الافتراضية): لازم تنضم لصورة standalone
  outputFileTracingIncludes: { "/api/extension/**": ["./extension/**/*"] },
};

export default nextConfig;
