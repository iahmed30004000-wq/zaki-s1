import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";

const rand = () => Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const EXT = join(process.cwd(), "extension");
const FIX = join(__dirname, "fixtures", "ext");
const BASE = "http://127.0.0.1:3217";
const fixture = (name: string, title = "") => readFileSync(join(FIX, name), "utf8").replace("TITLE_PLACEHOLDER", title);

// جسر بدل عامل الخلفية: نفس رسائل الإضافة، والنداءات للنظام الحقيقي بتوكن الجهاز. هيك بنختبر content.js والخادم مع بعض.
interface BridgeState {
  site: string;
  known: Record<string, number>;
  sets: Record<string, unknown>;
  sent: unknown[];
  stops: unknown[];
}
const newState = (site = "aliexpress"): BridgeState => ({ site, known: {}, sets: {}, sent: [], stops: [] });

async function installBridge(page: Page, device: APIRequestContext, state: BridgeState) {
  await page.exposeFunction("s1Bridge", async (msg: { type: string; url?: string; site?: string; [k: string]: unknown }) => {
    if (msg.type === "get-site") {
      const r = await device.get(`/api/extension/selectors?known=${encodeURIComponent(JSON.stringify(state.known))}`);
      for (const s of (await r.json()).sets) {
        state.sets[s.site] = s.selectors;
        state.known[s.site] = s.version;
      }
      const lx = (await (await device.get("/api/extension/lexicon")).json()).lexicon;
      for (const [id, set] of Object.entries(state.sets) as [string, { match: string[] }][]) {
        const re = (g: string) => new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^\\s]*") + "$", "i");
        if (set.match.some((m) => re(m).test(String(msg.url)))) return { ok: true, site: { id, set, lexicon: lx, config: { market: "SY" } }, connected: true, updateAvailable: false };
      }
      return { ok: true, site: null };
    }
    if (msg.type === "capture") {
      const r = await device.post("/api/extension/captures", { data: { site: msg.site, url: msg.url, market: msg.market, note: msg.note, items: (msg.items as { fields: unknown; missing: unknown; pageText?: string }[]).map((i) => ({ fields: i.fields, pageText: i.pageText })), counts: msg.counts, mode: "single" } });
      const body = await r.json();
      state.sent.push(body);
      return r.ok() ? { ok: true, ...body } : { ok: false, error: body?.error?.message ?? `خطأ ${r.status()}` };
    }
    if (msg.type === "stopped") {
      state.stops.push(msg);
      await device.post("/api/extension/events", { data: { type: "stopped", site: msg.site, url: msg.url, reason: msg.reason } });
      return { ok: true };
    }
    return { ok: false };
  });
  await page.addInitScript(() => {
    (window as unknown as { chrome: unknown }).chrome = { runtime: { lastError: null, sendMessage: (m: unknown, cb: (r: unknown) => void) => (window as unknown as { s1Bridge: (m: unknown) => Promise<unknown> }).s1Bridge(m).then(cb) } };
  });
}

// جهاز طازة لمالك التطوير: بنلغي القديم عشان ما نوصل حد الـ10 (كل تشغيل للاختبارات بيضيف أجهزة)
async function newDevice(page: Page, name: string): Promise<{ token: string; name: string; id: string }> {
  const list = (await (await page.request.get("/api/extension/devices")).json()).items as { id: string; active: boolean }[];
  for (const d of list.filter((x) => x.active)) await page.request.delete(`/api/extension/devices/${d.id}`);
  const r = await page.request.post("/api/extension/devices", { data: { name } });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}

async function openPage(page: Page, url: string, html: string) {
  await page.route(url.split("?")[0] + "**", (r) => r.fulfill({ body: html, contentType: "text/html; charset=utf-8" }));
  await page.goto(url);
  for (const f of ["lib/core.js", "lib/adapters.js", "content.js"]) await page.addScriptTag({ path: join(EXT, f) });
}

test.describe("الإضافة", () => {
  test.skip(!process.env.DATABASE_URL, "بحاجة قاعدة بيانات");

  test("بلا دخول وبلا توكن: كل نقاط الإضافة مقفولة", async ({ request }) => {
    for (const p of ["/api/extension/devices", "/api/extension/download", "/api/extension/selectors/admin"]) expect((await request.get(p)).status(), p).toBe(401);
    expect((await request.post("/api/extension/devices", { data: { name: "x" } })).status()).toBe(401);
    expect((await request.post("/api/extension/selectors/admin", { data: {} })).status()).toBe(401);
    for (const p of ["/api/extension/selectors", "/api/extension/lexicon", "/api/extension/version", "/api/extension/ping"]) {
      expect((await request.get(p)).status(), p).toBe(401);
      expect((await request.get(p, { headers: { authorization: "Bearer s1x_wrongwrongwrongwrongwrong" } })).status(), p).toBe(401);
    }
    expect((await request.post("/api/extension/captures", { data: {} })).status()).toBe(401);
    expect((await request.post("/api/extension/events", { data: {} })).status()).toBe(401);
    // توكن الأنظمة التانية (قراءة) ما بيفتح الإضافة
    expect((await request.get("/api/extension/ping", { headers: { authorization: "Bearer e2e-reader-token-production" } })).status()).toBe(401); // scan:ok
  });

  test("جهاز جديد من الشاشة، تنزيل الإضافة، صفحة منتج بتنحفظ كمرشح بالزر العائم، والتوكن الملغي بيوقف", async ({ page, playwright }) => {
    page.on("dialog", (d) => void d.accept());
    await page.goto("/login");
    await page.getByRole("button", { name: "دخول المالك (تطوير)" }).click();
    await expect(page.getByText("دورك: مالك")).toBeVisible();

    for (const d of ((await (await page.request.get("/api/extension/devices")).json()).items as { id: string; active: boolean }[]).filter((x) => x.active)) await page.request.delete(`/api/extension/devices/${d.id}`);
    // جهاز جديد من شاشة الإضافة: التوكن بيظهر مرة وحدة
    await page.goto("/extension");
    await expect(page.getByRole("heading", { name: "الإضافة والأجهزة" })).toBeVisible();
    const devName = `جهاز ${rand()}`;
    await page.getByLabel("اسم الجهاز").fill(devName);
    await page.getByRole("button", { name: "أنشئ" }).click();
    const token = await page.getByLabel("التوكن").inputValue();
    expect(token).toMatch(/^s1x_/);
    await expect(page.locator("tr[data-device]", { hasText: devName })).toContainText("فعّال");
    await page.reload();
    await expect(page.getByTestId("new-token")).toHaveCount(0); // ما بيظهر مرة تانية
    expect(await page.content()).not.toContain(token);

    // تنزيل الإضافة: zip فيه الملفات ورابط النظام
    const dl = await page.request.get("/api/extension/download");
    expect(dl.status()).toBe(200);
    expect(dl.headers()["content-type"]).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await dl.body()));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "background.js", "content.js", "INSTALL_AR.txt"]));
    expect(JSON.parse(strFromU8(files["manifest.json"])).manifest_version).toBe(3);

    const device = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
    expect((await (await device.get("/api/extension/ping")).json()).device).toBe(devName);
    expect((await (await device.get("/api/extension/version")).json()).version).toMatch(/^\d+\.\d+\.\d+$/);

    // صفحة منتج حقيقية الشكل: الزر العائم ← معاينة ← ابعت
    const title = `زيت إكليل الجبل ${rand()}`;
    const state = newState("aliexpress");
    await installBridge(page, device, state);
    await openPage(page, `https://www.aliexpress.com/item/${Math.floor(Math.random() * 1e9)}.html`, fixture("product.html", title));
    const fab = page.locator("#s1-host").getByRole("button", { name: "احفظ كمرشح" });
    await expect(fab).toBeVisible();
    await fab.click();
    const panel = page.locator("#s1-host");
    await expect(panel.getByText("معاينة قبل الإرسال")).toBeVisible();
    await expect(panel).toContainText(title);
    await expect(panel).toContainText("7.90");
    await expect(panel).toContainText("3400");
    await expect(panel).not.toContainText("seller@shop.com"); // الإيميل ما بيطلع بالمعاينة
    await panel.getByRole("button", { name: "ابعت" }).click();
    await expect(panel.getByText("انحفظ كمرشح ✓")).toBeVisible();
    expect(state.sent).toHaveLength(1);

    // المرشح انحفظ بالنظام
    const list = await (await page.request.get(`/api/candidates?q=${encodeURIComponent(title)}`)).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ titleAr: title, sourcesCount: 1 });
    await page.goto(`/candidates/${list.items[0].id}`);
    await expect(page.locator("tr[data-source='ext_aliexpress']")).toContainText("الإضافة");
    await page.goto("/extension");
    await expect(page.locator("tr[data-status='ok']").first()).toContainText("علي إكسبرس");

    // إلغاء الجهاز: التوكن بيوقف فوراً
    await page.locator("tr[data-device]", { hasText: devName }).getByRole("button", { name: "ألغِ" }).click();
    await expect(page.locator("tr[data-device]", { hasText: devName })).toContainText("ملغي");
    expect((await device.get("/api/extension/ping")).status()).toBe(401);
    await device.dispose();
  });

  test("صفحة فيها كابتشا بتوقف الإضافة وبتنبّه، وما بتحفظ شي", async ({ page, playwright }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "دخول المالك (تطوير)" }).click();
    const name = `وقف ${rand()}`;
    const dev = await newDevice(page, name);
    const device = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${dev.token}` } });
    const state = newState("aliexpress");
    await installBridge(page, device, state);
    await openPage(page, `https://www.aliexpress.com/item/${Math.floor(Math.random() * 1e9)}.html`, fixture("captcha.html"));
    await expect(page.locator("#s1-host")).toContainText("وقفت: الصفحة طالبة تحقق");
    await expect(page.locator("#s1-host").getByRole("button", { name: "احفظ كمرشح" })).toBeVisible(); // الزر موجود لكن الصفحة موقوفة: المعاينة بتوقف كمان
    await page.locator("#s1-host").getByRole("button", { name: "احفظ كمرشح" }).click();
    expect(state.sent).toHaveLength(0);
    await expect.poll(() => state.stops.length).toBeGreaterThan(0);
    // التنبيه بلوحة التنبيهات
    await expect
      .poll(async () => ((await (await page.request.get("/api/alerts")).json()).alerts as { type: string; message: string }[]).some((a) => a.type === "extension_stopped" && a.message.includes(name)))
      .toBe(true);
    await device.dispose();
  });

  test("المحددات اتغيّرت: الإضافة بتقول «ناقص»، والمالك بينشر نسخة جديدة، والإضافة بتشتغل بلا إعادة تثبيت", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "دخول المالك (تطوير)" }).click();
    const dev = await newDevice(page, `محددات ${rand()}`);
    const device = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${dev.token}` } });
    const title = `سيروم رموش ${rand()}`;
    const url = `https://www.aliexpress.com/item/${Math.floor(Math.random() * 1e9)}.html`;
    const state = newState("aliexpress");
    await installBridge(page, device, state);

    // 1) الصفحة غيّرت اسم العنوان: النسخة الحالية ما بتلاقيه
    await openPage(page, url, fixture("changed.html", title));
    await page.locator("#s1-host").getByRole("button", { name: "احفظ كمرشح" }).click();
    await expect(page.locator("#s1-host")).toContainText("ناقص: title");

    const sets = (await (await page.request.get("/api/extension/selectors/admin")).json()).items as { site: string; version: number; active: boolean; selectors: Record<string, unknown> }[];
    const current = sets.find((s) => s.site === "aliexpress" && s.active)!;
    try {
      // 2) المالك بينشر نسخة محددات جديدة من الشاشة
      const nextVersion = Math.max(...sets.filter((s) => s.site === "aliexpress").map((s) => s.version)) + 1;
      await page.goto("/extension");
      const fixed = JSON.parse(JSON.stringify(current.selectors));
      fixed.fields.title = { css: ".renamed-title, h1[data-pl='product-title']", read: "text" };
      await page.getByLabel("ملف المحددات (JSON)").fill(JSON.stringify(fixed));
      await page.getByRole("button", { name: "انشر كنسخة جديدة" }).click();
      await expect(page.getByTestId("publish-msg")).toContainText(`اننشرت النسخة ${nextVersion}`);
      await expect(page.locator("tr[data-site='aliexpress'][data-active='1']")).toContainText(String(nextVersion));

      // 3) نفس الإضافة بتاخد النسخة الجديدة وبتشتغل
      const page2 = await page.context().newPage();
      await installBridge(page2, device, state);
      await openPage(page2, url, fixture("changed.html", title));
      await page2.locator("#s1-host").getByRole("button", { name: "احفظ كمرشح" }).click();
      await expect(page2.locator("#s1-host")).toContainText(title);
      await page2.locator("#s1-host").getByRole("button", { name: "ابعت" }).click();
      await expect(page2.locator("#s1-host").getByText("انحفظ كمرشح ✓")).toBeVisible();
      expect((await (await page.request.get(`/api/candidates?q=${encodeURIComponent(title)}`)).json()).items).toHaveLength(1);

      // 4) ملف غلط من الشاشة بيترفض بالعربي، ورجوع للنسخة القديمة شغّال
      expect((await page.request.post("/api/extension/selectors/admin", { data: { ...fixed, match: ["https://*/*"] } })).status()).toBe(400);
      expect((await page.request.patch("/api/extension/selectors/admin", { data: { site: "aliexpress", version: current.version } })).status()).toBe(200);
    } finally {
      // الاختبار ما بيخلّف نسخة محددات فعّالة غريبة حتى لو فشل بنص الطريق
      await page.request.patch("/api/extension/selectors/admin", { data: { site: "aliexpress", version: current.version } });
    }
    await device.dispose();
  });

  test("مكتبة إعلانات ميتا: صفحة نتائج بعدة إعلانات بتنحفظ كمرشحين بتاريخ البدء وعدد النسخ", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "دخول المالك (تطوير)" }).click();
    const dev = await newDevice(page, `ميتا ${rand()}`);
    const device = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${dev.token}` } });
    const a = `إعلان زيت ${rand()}`;
    const b = `إعلان شامبو ${rand()}`;
    const state = newState("meta_adlib");
    await installBridge(page, device, state);
    const html = fixture("meta-results.html").replace("TITLE_A", a).replace("TITLE_B", b);
    await openPage(page, `https://www.facebook.com/ads/library/?q=${rand()}`, html);
    // القراءة الكاملة لقائمة الإعلانات من الصفحة نفسها (المحدد جاي من النظام عبر الجسر)
    await expect.poll(() => Boolean(state.sets["meta_adlib"])).toBe(true); // content.js بيسأل الجسر أول ما يفتح
    const site = state.sets["meta_adlib"] as unknown;
    expect(site).toBeTruthy();
    const out = await page.evaluate((set) => (window as unknown as { __s1: { run: (s: unknown, id: string, lex: unknown) => { ok: boolean; items: { fields: Record<string, unknown> }[] } } }).__s1.run(set, "meta_adlib", {}), site);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].fields).toMatchObject({ title: a, adStartDate: "2025-11-03", adVersions: 4, adCountries: ["Jordan", "Syria"] });
    expect(out.items[1].fields).toMatchObject({ title: b, adStartDate: "2025-10-10", adVersions: 1 });
    const r = await device.post("/api/extension/captures", { data: { site: "meta_adlib", url: page.url(), market: "JO", mode: "queue", items: out.items.map((i) => ({ fields: i.fields })) } });
    expect(r.status()).toBe(200);
    expect((await r.json()).saved).toBe(2);
    const found = await (await page.request.get(`/api/candidates?q=${encodeURIComponent("إعلان")}`)).json();
    expect((found.items as { titleAr: string }[]).map((c) => c.titleAr)).toEqual(expect.arrayContaining([a, b]));
    await device.dispose();
  });
});
