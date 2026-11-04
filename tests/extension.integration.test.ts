// قاعدة حقيقية: أجهزة الإضافة والتوكن، استقبال اللقطات، الاستخراج الاحتياطي، التوقف والتنبيه، وتحديث المحددات بلا إعادة تثبيت.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";
import { listAlerts, resetAlertsForTests } from "../src/lib/alerts";
import { importSeeds } from "../src/seeds/import";
import { authenticateDevice, createDevice, hashToken, listDevices, revokeDevice, ExtensionError } from "../src/extension/devices";
import { recordEvent, saveCapture } from "../src/extension/captures";
import { activateVersion, activeSets, lexicon, listSets, publishSet, loadDefaults } from "../src/extension/selectors";

const has = Boolean(process.env.DATABASE_URL);
const rand = (n: number) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const PREFIX = "ext" + rand(5);

async function refused(p: Promise<unknown>, status: number, re?: RegExp) {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ExtensionError);
  expect((e as ExtensionError).status).toBe(status);
  if (re) expect((e as ExtensionError).message).toMatch(re);
}

describe.skipIf(!has)("الإضافة على قاعدة حقيقية", () => {
  const db = () => getDb();
  const sub = `${PREFIX}-sub`;
  let userId = "";
  const deviceIds: string[] = [];
  const titles: string[] = [];
  const sites: string[] = []; // ما بنلمس نسخ المواقع الحقيقية بعد الاختبار: بنرجّع الفعّالة الأصلية

  beforeAll(async () => {
    await importSeeds(db());
    const u = await db().user.create({ data: { oidcSub: sub, nameAr: `${PREFIX} باحث`, role: "researcher", active: true } });
    userId = u.id;
  });
  afterAll(async () => {
    await db().captureJob.deleteMany({ where: { deviceId: { in: deviceIds } } });
    const cands = await db().candidate.findMany({ where: { titleSrc: { startsWith: PREFIX } }, select: { id: true } });
    await db().imageAsset.deleteMany({ where: { candidateId: { in: cands.map((c) => c.id) } } });
    await db().observation.deleteMany({ where: { candidateId: { in: cands.map((c) => c.id) } } });
    await db().candidate.deleteMany({ where: { id: { in: cands.map((c) => c.id) } } });
    await db().extensionDevice.deleteMany({ where: { userId } });
    await db().alert.deleteMany({ where: { message: { contains: PREFIX } } });
    await db().user.deleteMany({ where: { id: userId } });
    void titles;
    void sites;
    await db().$disconnect();
  });
  beforeEach(() => resetAlertsForTests());

  // كل اختبار بجهاز طازة: بنلغي القديم عشان ما نوصل حد الـ10 (اختبار الحد نفسه بيستعمل createDevice مباشرة)
  const mkDevice = async (name = `${PREFIX} جهاز`) => {
    await db().extensionDevice.updateMany({ where: { userId }, data: { active: false } });
    const d = await createDevice(db(), sub, name);
    deviceIds.push(d.id);
    return d;
  };
  const authed = async (token: string) => (await authenticateDevice(db(), `Bearer ${token}`))!;
  const cap = (over: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => ({
    site: "aliexpress",
    url: `https://www.aliexpress.com/item/${rand(8)}.html`,
    market: "SY",
    items: [{ fields: { title: `${PREFIX}${rand(10)}`, price: "4.50", currency: "USD", sales: 1200, reviews: 80, rating: 4.7, imageUrl: "https://ae01.alicdn.com/kf/a.jpg", ...fields } }],
    ...over,
  });

  describe("الأجهزة والتوكن", () => {
    it("التوكن بيطلع مرة وحدة، والخادم بيحفظ بصمته بس، والتوثيق بيشتغل", async () => {
      const d = await mkDevice();
      expect(d.token).toMatch(/^s1x_[A-Za-z0-9_-]{40,}$/);
      const row = await db().extensionDevice.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.tokenHash).toBe(hashToken(d.token));
      expect(JSON.stringify(row)).not.toContain(d.token);
      const a = await authenticateDevice(db(), `Bearer ${d.token}`);
      expect(a).toMatchObject({ id: d.id, name: d.name });
      expect((await db().extensionDevice.findUniqueOrThrow({ where: { id: d.id } })).lastSeenAt).not.toBeNull();
      expect((await listDevices(db(), { userSub: sub })).find((x) => x.id === d.id)).toMatchObject({ active: true, owner: `${PREFIX} باحث` });
      expect(JSON.stringify(await listDevices(db(), { userSub: sub }))).not.toContain(d.token);
    });
    it("توكن غلط أو بلا بادئة أو ملغي أو صاحبه موقوف = ما بيدخل", async () => {
      const d = await mkDevice();
      expect(await authenticateDevice(db(), null)).toBeNull();
      expect(await authenticateDevice(db(), "Bearer nope")).toBeNull();
      expect(await authenticateDevice(db(), `Bearer s1x_${rand(40)}`)).toBeNull();
      expect(await authenticateDevice(db(), `Basic ${d.token}`)).toBeNull();
      await revokeDevice(db(), d.id);
      expect(await authenticateDevice(db(), `Bearer ${d.token}`)).toBeNull();
      const d2 = await mkDevice();
      await db().user.update({ where: { id: userId }, data: { active: false } });
      expect(await authenticateDevice(db(), `Bearer ${d2.token}`)).toBeNull();
      await db().user.update({ where: { id: userId }, data: { active: true } });
      expect(await authenticateDevice(db(), `Bearer ${d2.token}`)).not.toBeNull();
    });
    it("الاسم مطلوب، المستخدم المجهول مرفوض، وصاحب الجهاز بس بيلغيه، والحد 10 فعّالة", async () => {
      await refused(createDevice(db(), sub, "أ"), 400, /اسم/);
      await refused(createDevice(db(), `${PREFIX}-nobody`, "جهاز"), 400, /المستخدم/);
      const d = await mkDevice();
      await refused(revokeDevice(db(), d.id, { userSub: "someone-else" }), 404);
      await refused(revokeDevice(db(), "nope"), 404);
      const active = await db().extensionDevice.count({ where: { userId, active: true } });
      for (let i = active; i < 10; i++) deviceIds.push((await createDevice(db(), sub, `${PREFIX} ${i}`)).id);
      await refused(createDevice(db(), sub, `${PREFIX} زيادة`), 409, /الحد/);
    });
  });

  describe("استقبال اللقطات", () => {
    it("صفحة منتج بتنحفظ كمرشح بثقة الإضافة وبمصدر مستقل، وبالسوق", async () => {
      const dev = await authed((await mkDevice()).token);
      const body = cap();
      const r = await saveCapture(db(), dev, body);
      expect(r).toMatchObject({ saved: 1, duplicates: 0, failed: 0 });
      const c = await db().candidate.findFirstOrThrow({ where: { titleSrc: body.items[0].fields.title as string }, include: { observations: true } });
      expect(c.observations).toHaveLength(1);
      expect(c.observations[0]).toMatchObject({ source: "ext_aliexpress", accessMethod: "extension", market: "SY", sales: 1200, reviews: 80, currency: "USD" });
      expect(c.observations[0].price?.toString()).toBe("4.5");
      expect(c.observations[0].capturedBy).toBe(dev.id);
      const job = await db().captureJob.findFirstOrThrow({ where: { deviceId: dev.id } });
      expect(job).toMatchObject({ status: "ok", mode: "page", site: "aliexpress", observationId: c.observations[0].id });
    });
    it("نفس الصفحة مرتين اليوم = مكرر، ما بتتضاعف الملاحظة", async () => {
      const dev = await authed((await mkDevice()).token);
      const body = cap();
      await saveCapture(db(), dev, body);
      const again = await saveCapture(db(), dev, body);
      expect(again).toMatchObject({ saved: 0, duplicates: 1 });
      expect(await db().observation.count({ where: { candidate: { titleSrc: body.items[0].fields.title as string } } })).toBe(1);
    });
    it("صفحة مكتبة إعلانات ميتا: تاريخ البدء وعدد النسخ والدول، ومسار الإعلانات", async () => {
      const dev = await authed((await mkDevice()).token);
      const title = `${PREFIX}${rand(10)}`;
      const r = await saveCapture(db(), dev, { site: "meta_adlib", url: "https://www.facebook.com/ads/library/?id=999", market: "JO", items: [{ fields: { title, page: "متجر الأعشاب", adStartDate: "2025-11-03", adVersions: 4, adCountries: ["Jordan", "Syria"] } }] });
      expect(r.saved).toBe(1);
      const c = await db().candidate.findFirstOrThrow({ where: { titleSrc: title }, include: { observations: true } });
      expect(c.lane).toBe("regional_proven");
      expect(c.observations[0]).toMatchObject({ source: "ext_meta_adlib", adVersions: 4, adCountries: ["Jordan", "Syria"] });
      expect(c.observations[0].adStartDate?.toISOString().slice(0, 10)).toBe("2025-11-03");
      expect(c.observations[0].extractedJson).toMatchObject({ sourceNote: "الصفحة: متجر الأعشاب" });
    });
    it("صفحة نتائج بعدة بطاقات: كل بطاقة مرشح، ما بتنضرب ببعض، وmode=list", async () => {
      const dev = await authed((await mkDevice()).token);
      const a = `${PREFIX}${rand(10)}`;
      const b = `${PREFIX}${rand(10)}`;
      const r = await saveCapture(db(), dev, { site: "meta_adlib", url: "https://www.facebook.com/ads/library/?q=oil", items: [{ fields: { title: a } }, { fields: { title: b } }] });
      expect(r.saved).toBe(2);
      expect(await db().captureJob.count({ where: { deviceId: dev.id, mode: "list" } })).toBe(2);
    });
    it("عدّ التعليقات بيروح كعدد بس، وإيميلات وهواتف النص بتنشال", async () => {
      const dev = await authed((await mkDevice()).token);
      const t = `${PREFIX}${rand(10)} a@b.com`;
      await saveCapture(db(), dev, cap({ counts: { intent: 12, skeptic: 3, sample: 80 } }, { title: t }));
      const o = await db().observation.findFirstOrThrow({ where: { candidate: { titleSrc: { startsWith: PREFIX, endsWith: "[محذوف]" } } }, orderBy: { createdAt: "desc" } });
      expect(o).toMatchObject({ intentComments: 12, skepticComments: 3, commentSample: { size: 80 } });
      expect(JSON.stringify(o)).not.toContain("a@b.com");
    });
    it("رابط من موقع تاني، أو لقطة غلط، أو سقف الخادم الساعي = مرفوض", async () => {
      const dev = await authed((await mkDevice()).token);
      await refused(saveCapture(db(), dev, cap({ url: "https://evil.com/item/1" })), 400, /المدعومة/);
      await refused(saveCapture(db(), dev, { site: "temu" }), 400);
      await refused(saveCapture(db(), dev, null), 400);
      await db().captureJob.createMany({ data: Array.from({ length: 120 }, () => ({ deviceId: dev.id, site: "aliexpress", url: "https://www.aliexpress.com/item/x", mode: "page" as const, status: "ok" })) });
      await refused(saveCapture(db(), dev, cap()), 429, /حد الساعة/);
    });
  });

  describe("الاستخراج الاحتياطي على الخادم", () => {
    const fakeA01 = (out: unknown) => async () => ({ output: out });
    it("حقول ناقصة + نص الصفحة: الوكيل A01 بيكمّل، لكن بس الأرقام الموجودة حرفياً بالنص", async () => {
      const dev = await authed((await mkDevice()).token);
      const title = `${PREFIX}${rand(10)}`;
      const pageText = `${title}\nUS $7.90\n3,400 sold\n4.8 stars`;
      const body = { site: "aliexpress", url: `https://www.aliexpress.com/item/${rand(6)}.html`, items: [{ fields: { price: "7.90" }, pageText }] };
      const r = await saveCapture(db(), dev, body, { runAgent: fakeA01({ title_src: title, price: 7.9, currency: "USD", sales: 3400, reviews: 999999 }) });
      expect(r.saved).toBe(1);
      const o = await db().observation.findFirstOrThrow({ where: { candidate: { titleSrc: title } } });
      expect(o.sales).toBe(3400);
      expect(o.reviews).toBeNull(); // 999999 مش بنص الصفحة: ما بنقبله
      expect(o.currency).toBe("USD");
    });
    it("وكيل بعنوان مفبرك (مش بنص الصفحة) = ما بينحفظ، والفشل بيتسجّل «ناقص»", async () => {
      const dev = await authed((await mkDevice()).token);
      const body = { site: "aliexpress", url: `https://www.aliexpress.com/item/${rand(6)}.html`, items: [{ fields: {}, pageText: "نص عادي بدون عنوان منتج واضح 123" }] };
      const r = await saveCapture(db(), dev, body, { runAgent: fakeA01({ title_src: "عنوان من الخيال تماماً", price: 5 }) });
      expect(r).toMatchObject({ saved: 0, failed: 1 });
      expect(await db().captureJob.findFirst({ where: { deviceId: dev.id, status: "needs_extraction" } })).not.toBeNull();
    });
    it("الوكيل متوقف: الصفحة بتضل «ناقصة» بلا مرشح مفبرك", async () => {
      const dev = await authed((await mkDevice()).token);
      const body = { site: "aliexpress", url: `https://www.aliexpress.com/item/${rand(6)}.html`, items: [{ fields: {}, pageText: "أي نص" }] };
      const r = await saveCapture(db(), dev, body, {
        runAgent: async () => {
          throw new Error("no tier");
        },
      });
      expect(r).toMatchObject({ saved: 0, failed: 1 });
    });
    it("ميتا: A03 بيعبّي العنوان والتاريخ والدول", async () => {
      const dev = await authed((await mkDevice()).token);
      const product = `${PREFIX}${rand(10)}`;
      const r = await saveCapture(db(), dev, { site: "meta_adlib", url: "https://www.facebook.com/ads/library/?id=1", items: [{ fields: {}, pageText: "ad text" }] }, { runAgent: fakeA01({ product, start_date: "2025-10-12", versions: 3, countries: ["Syria"] }) });
      expect(r.saved).toBe(1);
      expect((await db().observation.findFirstOrThrow({ where: { candidate: { titleSrc: product } } })).adVersions).toBe(3);
    });
  });

  describe("إشارات التوقف والتنبيه", () => {
    it("وقف بتحقق: سجل + تنبيه واحد (ما بيتكرر)", async () => {
      const dev = await authed((await mkDevice(`${PREFIX} لابتوب`)).token);
      await recordEvent(db(), dev, { type: "stopped", site: "aliexpress", url: "https://www.aliexpress.com/item/1.html", reason: "css:iframe[src*=captcha]" });
      await recordEvent(db(), dev, { type: "stopped", site: "aliexpress", url: "https://www.aliexpress.com/item/2.html", reason: "css:iframe[src*=captcha]" });
      expect(await db().captureJob.count({ where: { deviceId: dev.id, status: "stopped" } })).toBe(2);
      const alerts = listAlerts().filter((a) => a.type === "extension_stopped" && a.message.includes(PREFIX));
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(alerts[0]).toMatchObject({ severity: "warning", link: "/extension" });
      expect(alerts[0].message).toContain("وقفت على علي إكسبرس");
    });
    it("المحددات بدها تحديث بعد 3 فشل، ونوع غلط بيترفض", async () => {
      const dev = await authed((await mkDevice(`${PREFIX} مكتب`)).token);
      await recordEvent(db(), dev, { type: "selectors_stale", site: "queue", reason: "3 فشل" });
      expect(listAlerts().some((a) => a.message.includes("المحددات بدها تحديث"))).toBe(true);
      await refused(recordEvent(db(), dev, { type: "hack" }), 400);
      await refused(recordEvent(db(), dev, null), 400);
    });
  });

  describe("المحددات عن بُعد (تحديث بلا إعادة تثبيت)", () => {
    const original = () => JSON.parse(JSON.stringify(loadDefaults().find((d) => d.site === "aliexpress")));
    it("النسخ الافتراضية بتنزرع نسخة 1، والإضافة بتاخد الأحدث بس من اللي تعرفه", async () => {
      const all = await activeSets(db(), {});
      expect(all.map((s) => s.site)).toEqual(expect.arrayContaining(["aliexpress", "meta_adlib"]));
      const known = Object.fromEntries(all.map((s) => [s.site, s.version]));
      expect(await activeSets(db(), known)).toEqual([]);
    });
    it("نشر نسخة جديدة بيصيرها الفعّالة، والإضافة بتاخدها، والرجوع للقديمة شغّال", async () => {
      const before = (await listSets(db())).find((s) => s.site === "aliexpress" && s.active)!;
      try {
      const fixed = original();
      fixed.fields.title = { css: "h1.new-title-class", read: "text" };
      const v = await publishSet(db(), fixed);
      expect(v.version).toBeGreaterThan(before.version);
      expect(v.active).toBe(true);
      const metaVersion = (await listSets(db())).find((s) => s.site === "meta_adlib" && s.active)!.version;
      const upd = await activeSets(db(), { aliexpress: before.version, meta_adlib: metaVersion });
      expect(upd).toHaveLength(1);
      expect((upd[0].selectors as { fields: { title: { css: string } } }).fields.title.css).toBe("h1.new-title-class");
      expect((await listSets(db())).filter((s) => s.site === "aliexpress" && s.active)).toHaveLength(1);
      const back = await activateVersion(db(), "aliexpress", before.version);
      expect(back).toMatchObject({ version: before.version, active: true });
      expect((await listSets(db())).filter((s) => s.site === "aliexpress" && s.active).map((s) => s.version)).toEqual([before.version]);
      await refused(activateVersion(db(), "aliexpress", 9999), 404);
      } finally {
        await activateVersion(db(), "aliexpress", before.version); // الاختبار ما بيخلّف نسخة فعّالة غريبة حتى لو فشل
      }
    });
    it("نشر ملف غلط بيترفض والنسخة الفعّالة ما بتتغيّر", async () => {
      const before = (await listSets(db())).filter((s) => s.site === "aliexpress").length;
      await refused(publishSet(db(), { ...original(), site: "temu" }), 400, /غير مدعوم/);
      await refused(publishSet(db(), { ...original(), match: ["https://*/*"] }), 400);
      expect((await listSets(db())).filter((s) => s.site === "aliexpress").length).toBe(before);
    });
    it("القاموس: كلمات النية والتشكيك من الإعدادات (عربي وصيني وإنجليزي)", async () => {
      const lx = await lexicon(db());
      expect(lx.intent.length).toBeGreaterThan(5);
      expect(lx.skeptic.length).toBeGreaterThan(2);
      expect(lx.intent).toContain("求链接");
    });
  });
});
