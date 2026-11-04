// منطق الإضافة الصافي: أرقام · خصوصية · توقف · حدود القائمة · المحوّلات · التحقق من ملفات المحددات.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { validateSelectorSet, loadDefaults } from "../src/extension/selectors";
import { validateCapture } from "../src/extension/captures";
import { buildBundle, systemOrigin } from "../src/extension/bundle";
import { unzipSync, strFromU8 } from "fflate";

const require = createRequire(import.meta.url);
const S1 = require("../extension/lib/core.js");
const { adapters, parseAdDate } = require("../extension/lib/adapters.js");

describe("أرقام وأسعار", () => {
  it("parseCount: فواصل وK وأعداد صينية وعربية", () => {
    expect(S1.parseCount("1,234 sold")).toBe(1234);
    expect(S1.parseCount("12K+")).toBe(12000);
    expect(S1.parseCount("1.2万")).toBe(12000);
    expect(S1.parseCount("٣٤٥ طلب")).toBe(345);
    expect(S1.parseCount("بلا رقم")).toBeNull();
    expect(S1.parseCount(null)).toBeNull();
  });
  it("parseMoney: عملة وفاصلة عشرية", () => {
    expect(S1.parseMoney("US $12.50 - 15")).toEqual({ amount: "12.50", currency: "USD" });
    expect(S1.parseMoney("12,50 €")).toEqual({ amount: "12.50", currency: "EUR" });
    expect(S1.parseMoney("1,299.99 JOD")).toEqual({ amount: "1299.99", currency: "JOD" });
    expect(S1.parseMoney("مجاني")).toBeNull();
  });
});

describe("خصوصية", () => {
  it("بتشيل الإيميلات وأرقام الهواتف وبتبقي الأرقام العادية", () => {
    expect(S1.scrubText("كلمني ع a.b@mail.com أو +962 79 123 4567 شكراً")).toBe("كلمني ع أو شكراً");
    expect(S1.scrubText("طلبت 12 قطعة بسعر 45")).toBe("طلبت 12 قطعة بسعر 45");
  });
  it("تعليقات النية والتشكيك: العدد بس", () => {
    const r = S1.countComments(["بدي رابط", "هاد نصب وكذب", "حلو", "price? where to buy"], { intent: ["رابط", "where to buy"], skeptic: ["نصب"] });
    expect(r).toEqual({ intent: 2, skeptic: 1, sample: 4 });
    expect(JSON.stringify(r)).not.toContain("رابط");
  });
});

describe("إشارات التوقف", () => {
  const rules = { css: ["iframe[src*=captcha]"], text: ["captcha", "verify"], url: ["login"] };
  const page = (o: object) => ({ url: "https://www.aliexpress.com/item/1.html", title: "منتج", text: "", has: () => false, ...o });
  it("css وurl ونص", () => {
    expect(S1.detectStop(page({ has: (c: string) => c.includes("captcha") }), rules)).toMatchObject({ kind: "css" });
    expect(S1.detectStop(page({ url: "https://login.aliexpress.com/x" }), rules)).toMatchObject({ kind: "url" });
    expect(S1.detectStop(page({ text: "Please complete the CAPTCHA to continue" }), rules)).toMatchObject({ kind: "text" });
  });
  it("«Verified purchase» ما بتوقف (كلمة كاملة بس)", () => {
    expect(S1.detectStop(page({ text: "Verified purchase 5 stars" }), rules)).toBeNull();
    expect(S1.detectStop(page({ text: "منتج عادي" }), rules)).toBeNull();
  });
});

describe("حدود وضع القائمة", () => {
  const L = S1.DEFAULT_LIMITS;
  it("التأخير بين 45 و90 ثانية", () => {
    expect(S1.nextDelay(L, () => 0)).toBe(45000);
    expect(S1.nextDelay(L, () => 1)).toBe(90000);
    for (let i = 0; i < 50; i++) {
      const d = S1.nextDelay(L);
      expect(d).toBeGreaterThanOrEqual(45000);
      expect(d).toBeLessThanOrEqual(90000);
    }
  });
  it("استراحة 10 دقايق كل 20 صفحة", () => {
    const st = S1.newQueueState();
    let now = 1_000_000;
    for (let i = 0; i < 19; i++) S1.recordSuccess(st, (now += 60_000), L);
    expect(S1.canProceed(st, now + 1, L).ok).toBe(true);
    S1.recordSuccess(st, (now += 60_000), L);
    const c = S1.canProceed(st, now + 1, L);
    expect(c).toMatchObject({ ok: false, reason: "break" });
    expect(c.waitMs).toBeLessThanOrEqual(600_000);
    expect(S1.canProceed(st, now + 600_001, L).ok).toBe(true);
  });
  it("الحد الساعي 40 والحد اليومي 200", () => {
    const hour = S1.newQueueState();
    const t0 = 5_000_000;
    for (let i = 0; i < 40; i++) hour.history.push(t0 + i * 1000);
    expect(S1.canProceed(hour, t0 + 41_000, L)).toMatchObject({ ok: false, reason: "hour" });
    expect(S1.canProceed(hour, t0 + 3_700_000, L).ok).toBe(true);
    const day = S1.newQueueState();
    for (let i = 0; i < 200; i++) day.history.push(t0 + i * 400_000); // موزعة ع أكتر من ساعة: ما بتلمس الساعي
    expect(S1.canProceed(day, t0 + 200 * 400_000, L)).toMatchObject({ ok: false, reason: "day" });
  });
  it("3 فشل متتالي بتوقف، والنجاح بيصفّر العدّاد", () => {
    const st = S1.newQueueState();
    S1.recordFailure(st);
    S1.recordFailure(st);
    S1.recordSuccess(st, 1000, L);
    expect(st.failures).toBe(0);
    S1.recordFailure(st);
    S1.recordFailure(st);
    S1.recordFailure(st);
    expect(S1.canProceed(st, 5000, L)).toMatchObject({ ok: false, reason: "failures", waitMs: null });
  });
  it("التوقف بإشارة تحقق ما بيكمل إلا باستئناف", () => {
    const st = S1.recordStop(S1.newQueueState(), "css:captcha");
    expect(S1.canProceed(st, 1, L)).toMatchObject({ ok: false, reason: "stopped" });
  });
  it("الوقت المتوقع بيحترم الحد الساعي: 40 صفحة ≥ ساعة تقريباً، و100 صفحة > ساعتين", () => {
    expect(S1.estimateMs(1)).toBeLessThan(120_000);
    expect(S1.estimateMs(100)).toBeGreaterThan(2 * 3_600_000);
    expect(S1.estimateMs(250)).toBeGreaterThan(24 * 3_600_000 - 3_600_000); // الحد اليومي 200
  });
});

describe("المحوّلات", () => {
  it("تواريخ مكتبة الإعلانات", () => {
    expect(parseAdDate("Started running on 12 Oct 2025")).toBe("2025-10-12");
    expect(parseAdDate("Oct 5, 2025")).toBe("2025-10-05");
    expect(parseAdDate("2025-01-09")).toBe("2025-01-09");
    expect(parseAdDate("بلا تاريخ")).toBeNull();
  });
  it("ميتا: التاريخ والنسخ والدول والصيغة من نص البطاقة", () => {
    const out = adapters.meta_adlib.post({ title: "زيت للشعر" }, { text: "Library ID: 123\nStarted running on 3 Nov 2025\n4 ads use this creative and text\nShown in: Jordan, Syria\nVideo 0:05 / 0:30" });
    expect(out).toMatchObject({ adStartDate: "2025-11-03", adVersions: 4, format: "video" });
    expect(out.adCountries).toEqual(["Jordan", "Syria"]);
  });
  it("علي إكسبرس: أول صورة بس", () => {
    expect(adapters.aliexpress.post({ imageUrl: ["https://a/1.jpg", "https://a/2.jpg"] }).imageUrl).toBe("https://a/1.jpg");
  });
});

describe("ملفات المحددات: التحقق", () => {
  const good = () => JSON.parse(JSON.stringify(loadDefaults().find((d) => d.site === "aliexpress")));
  it("الافتراضيان صالحان", () => {
    expect(loadDefaults().map((d) => d.site).sort()).toEqual(["aliexpress", "meta_adlib"]);
  });
  it("موقع غير مدعوم أو نمط خارج المواقع المدعومة بيترفض", () => {
    expect(() => validateSelectorSet({ ...good(), site: "temu" })).toThrow(/غير مدعوم/);
    expect(() => validateSelectorSet({ ...good(), match: ["https://*/*"] })).toThrow(/خارج المواقع المدعومة/);
    expect(() => validateSelectorSet({ ...good(), match: ["https://evil.com/item/*"] })).toThrow(/خارج المواقع المدعومة/);
    expect(() => validateSelectorSet({ ...good(), match: ["http://www.aliexpress.com/item/*"] })).toThrow();
    expect(() => validateSelectorSet({ ...good(), match: ["https://www.aliexpress.com.evil.io/item/*"] })).toThrow(/خارج/);
  });
  it("حقول غلط: محدد ناقص · read غلط · regex مكسور · required مجهول", () => {
    const g = good();
    expect(() => validateSelectorSet({ ...g, fields: { title: { read: "text" } } })).toThrow(/المحدد/);
    expect(() => validateSelectorSet({ ...g, fields: { title: { css: "h1", read: "eval" } } })).toThrow(/read/);
    expect(() => validateSelectorSet({ ...g, fields: { title: { css: "h1", regex: "(" } } })).toThrow(/regex/);
    expect(() => validateSelectorSet({ ...g, required: ["nope"] })).toThrow(/required/);
    expect(() => validateSelectorSet({ ...g, fields: {} })).toThrow();
    expect(() => validateSelectorSet("نص")).toThrow();
  });
});

describe("التحقق من اللقطة", () => {
  const base = () => ({ site: "aliexpress", url: "https://www.aliexpress.com/item/100.html", market: "sy", items: [{ fields: { title: "زيت للشعر", price: "4.50", currency: "USD", sales: 1200 } }] });
  it("لقطة سليمة بتتنظّف وبيصير السوق كبير", () => {
    const c = validateCapture(base());
    expect(c).toMatchObject({ site: "aliexpress", market: "SY", mode: "page" });
    expect(c.items[0]).toMatchObject({ title: "زيت للشعر", price: "4.50", sales: 1200 });
  });
  it("رابط من موقع تاني أو http أو موقع غير مدعوم بيترفض", () => {
    expect(() => validateCapture({ ...base(), url: "https://evil.com/item/1" })).toThrow(/المدعومة/);
    expect(() => validateCapture({ ...base(), url: "http://www.aliexpress.com/item/1" })).toThrow();
    expect(() => validateCapture({ ...base(), site: "temu" })).toThrow(/غير مدعوم/);
    expect(() => validateCapture({ ...base(), market: "SYR" })).toThrow(/حرفين/);
    expect(() => validateCapture({ ...base(), items: [] })).toThrow();
  });
  it("إيميلات وهواتف بالنص بتنشال، والأسعار الغلط بتنتجاهل", () => {
    const c = validateCapture({ ...base(), items: [{ fields: { title: "منتج a@b.com +962791234567 حلو", price: "abc", sales: -5 } }] });
    expect(c.items[0].title).toBe("منتج [محذوف] [محذوف] حلو"); // نفس تنظيف المصادر الباقية بالنظام
    expect(c.items[0].title).not.toMatch(/@|\d{6}/);
    expect(c.items[0].price).toBeNull();
    expect(c.items[0].sales).toBeNull();
  });
  it("عدّ التعليقات: العدد لازم أقل من العيّنة، وما في نص خام", () => {
    expect(validateCapture({ ...base(), counts: { intent: 3, skeptic: 1, sample: 50 } }).counts).toEqual({ intent: 3, skeptic: 1, sample: 50 });
    expect(() => validateCapture({ ...base(), counts: { intent: 60, skeptic: 1, sample: 50 } })).toThrow(/العيّنة/);
    const c = validateCapture({ ...base(), counts: { intent: 1, skeptic: 0, sample: 5, comments: ["بدي رابط يا أحمد"] } });
    expect(JSON.stringify(c)).not.toContain("أحمد");
  });
  it("قائمة (أكتر من عنصر) = وضع list، وحد 20", () => {
    const it1 = { fields: { title: "أ" } };
    expect(validateCapture({ ...base(), items: [it1, it1] }).mode).toBe("list");
    expect(() => validateCapture({ ...base(), items: Array.from({ length: 21 }, () => it1) })).toThrow(/20/);
  });
});

describe("حزمة التنزيل", () => {
  it("systemOrigin: https أو localhost بس", () => {
    expect(systemOrigin("https://s1.zakiai.io/x")).toBe("https://s1.zakiai.io");
    expect(systemOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(systemOrigin("http://evil.com")).toBeNull();
    expect(systemOrigin(undefined)).toBeNull();
  });
  it("الـ zip فيه كل الملفات + رابط النظام بالصلاحيات + خطوات التثبيت، وما فيه أسرار", () => {
    const files = unzipSync(buildBundle("https://s1.zakiai.io"));
    for (const f of ["manifest.json", "background.js", "content.js", "lib/core.js", "lib/adapters.js", "popup/popup.html", "options/options.html", "selectors/aliexpress.json", "selectors/meta_adlib.json", "INSTALL_AR.txt", "defaults.json"]) expect(Object.keys(files), f).toContain(f);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest.host_permissions).toContain("https://s1.zakiai.io/*");
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions.some((h: string) => h === "<all_urls>" || h === "*://*/*" || h === "https://*/*")).toBe(false); // صلاحيات المواقع المدعومة بس
    expect(JSON.parse(strFromU8(files["defaults.json"]))).toEqual({ systemUrl: "https://s1.zakiai.io" });
    expect(strFromU8(files["INSTALL_AR.txt"])).toContain("وضع المطوّر");
    expect(Object.values(files).map((f) => strFromU8(f)).join("\n")).not.toMatch(/s1x_[A-Za-z0-9_-]{20,}/);
  });
  it("الإضافة: ولا صلاحية «كل المواقع» ولا تبويبات ولا تصفّح بالخلفية", () => {
    const m = JSON.parse(strFromU8(unzipSync(buildBundle(undefined))["manifest.json"]));
    expect(m.permissions).toEqual(["storage", "alarms", "scripting"]);
    for (const cs of m.content_scripts) expect(cs.matches.every((x: string) => /^https:\/\/(\*\.aliexpress\.(com|us)|(www\.)?facebook\.com\/ads\/library)/.test(x))).toBe(true);
  });
});
