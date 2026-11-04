import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// الرفض هو الافتراضي: كل ملف route لازم يستعمل الحارس، إلا القائمة العامة المقصودة.
const PUBLIC = new Set([
  "src/app/api/health/route.ts",
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/callback/route.ts",
  "src/app/api/auth/logout/route.ts",
  "src/app/api/auth/dev-login/route.ts",
  // محمية بتوقيع الحدث أو بتوكن كل نظام (مش بجلسة موظف)
  "src/app/api/s1/v1/webhooks/[system]/route.ts",
  "src/app/api/s1/v1/products/[ref]/compliance/route.ts",
  "src/app/api/s1/v1/candidates/route.ts",
  "src/app/api/s1/v1/events/route.ts",
  // الإضافة: محمية بتوكن الجهاز (الخادم بيحفظ بصمته بس)
  "src/app/api/extension/captures/route.ts",
  "src/app/api/extension/selectors/route.ts",
  "src/app/api/extension/lexicon/route.ts",
  "src/app/api/extension/version/route.ts",
  "src/app/api/extension/ping/route.ts",
  "src/app/api/extension/events/route.ts",
  // ويبهوك تيليجرام: سر الهيدر (secret_token) + chat id المالك
  "src/app/api/telegram/webhook/route.ts",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p.replace(/\\/g, "/")];
  });
}

describe("كل نقطة API بتفحص الصلاحية", () => {
  const routes = walk("src/app/api").filter((f) => f.endsWith("/route.ts"));

  it("في نقاط", () => {
    expect(routes.length).toBeGreaterThan(3);
  });

  for (const f of routes) {
    it(f, () => {
      const src = readFileSync(f, "utf8");
      if (PUBLIC.has(f)) {
        expect(src).toContain("عام عن قصد");
        return;
      }
      expect(src).toMatch(/\bguard(Authenticated)?(<[^>]*>)?\(/);
      // أي دالة تصدّرها لازم تكون محروسة
      for (const m of src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)) {
        throw new Error(`${f}: ${m[1]} غير محروس`);
      }
    });
  }
});
