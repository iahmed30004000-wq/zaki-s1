// تسخين خادم التطوير: أول طلب لكل صفحة بيتأخر لأنه بيترجم الصفحة. بنفتحهم كلهم قبل الاختبارات عشان ما تنتهي مهلة نقرة بالغلط.
const PAGES = ["/login", "/", "/users", "/gateway", "/settings", "/libraries", "/admin/db", "/agents", "/prompts", "/prompts/H02", "/api/me", "/api/agents", "/api/prompts", "/integrations", "/calc", "/dna", "/sources", "/imports", "/candidates", "/api/integrations", "/api/s1/v1/candidates", "/review", "/batches", "/licenses", "/libraries?tab=claims", "/extension"];

export default async function globalSetup() {
  const base = "http://127.0.0.1:3217";
  for (const p of PAGES) {
    try {
      await fetch(base + p, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    } catch {
      /* التسخين بس: الاختبار الفعلي بيكشف أي مشكلة */
    }
  }
}
