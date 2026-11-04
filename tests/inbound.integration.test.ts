// قاعدة حقيقية: استقبال الأحداث (توقيع · وقت · مكرر)، وقواعد الادعاءات لكل منتج، وقراءة المرشحين.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";
import { importSeeds } from "../src/seeds/import";
import { clearEventHandlersForTests, receiveEvent, registerEventHandler } from "../src/adapters/inbound";
import { signBody } from "../src/adapters/signing";
import { resetLimitsForTests } from "../src/adapters/limiter";
import { buildCompliance, listCandidatesFor } from "../src/adapters/product-compliance";
import { validateShape } from "../src/agents/shape";
import { COMPLIANCE_RESPONSE } from "../src/adapters/contracts";

const has = Boolean(process.env.DATABASE_URL);
const SECRET = "inbound-test-secret"; // scan:ok
const env = { WEBHOOK_SECRET_PRODUCTION: SECRET, WEBHOOK_SECRET_OMS: SECRET }; // scan:ok
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function event(type: string, id = `evt_${uniq()}`, data: unknown = { brief_id: "br_77" }) {
  return JSON.stringify({ event_id: id, type, occurred_at: "2026-10-12T12:00:00+03:00", data });
}
function signed(raw: string, nowS: number, secret = SECRET) {
  const ts = String(nowS);
  return { rawBody: raw, timestamp: ts, signature: signBody(secret, ts, raw) };
}

describe.skipIf(!has)("استقبال الأحداث وقراءة الأنظمة التانية على قاعدة حقيقية", () => {
  const db = () => getDb();
  const NOW = Math.floor(Date.now() / 1000);
  beforeAll(async () => {
    await importSeeds(db());
  });
  afterAll(async () => {
    await db().$disconnect();
  });
  beforeEach(() => {
    resetLimitsForTests();
    clearEventHandlersForTests();
  });

  it("حدث بتوقيع صح بيتسجّل وبيتعالج", async () => {
    const seen: string[] = [];
    registerEventHandler("brief.accepted", async (_d, e) => void seen.push(e.eventId));
    const raw = event("brief.accepted");
    const r = await receiveEvent(db(), "production", signed(raw, NOW), env, NOW);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    const row = await db().inboundEvent.findFirstOrThrow({ where: { system: "production", eventId: r.body.event_id as string } });
    expect(row).toMatchObject({ signatureOk: true, eventType: "brief.accepted", error: null });
    expect(row.processedAt).not.toBeNull();
    expect(seen).toEqual([r.body.event_id]);
  });

  it("حدث بتوقيع غلط بينرفض (401) وما بيتعالج، وبيتسجّل مرفوض بلا محتواه", async () => {
    const seen: string[] = [];
    registerEventHandler("brief.accepted", async (_d, e) => void seen.push(e.eventId));
    const raw = event("brief.accepted");
    const bad = { ...signed(raw, NOW), signature: "ab".repeat(32) };
    const r = await receiveEvent(db(), "production", bad, env, NOW);
    expect(r.status).toBe(401);
    expect(seen).toEqual([]);
    const rejected = await db().inboundEvent.findFirst({ where: { system: "production", signatureOk: false }, orderBy: { createdAt: "desc" } });
    expect(rejected?.eventType).toBe("rejected");
    expect(JSON.stringify(rejected?.payloadJson)).not.toContain("brief_id");
    // جسم معدّل بعد التوقيع
    const tampered = { ...signed(raw, NOW), rawBody: raw.replace("br_77", "br_99") };
    expect((await receiveEvent(db(), "production", tampered, env, NOW)).status).toBe(401);
  });

  it("وقت أقدم من 5 دقايق بينرفض، وبلا ترويسات بينرفض", async () => {
    const raw = event("brief.accepted");
    const old = signed(raw, NOW - 301);
    expect((await receiveEvent(db(), "production", old, env, NOW)).status).toBe(401);
    expect((await receiveEvent(db(), "production", { rawBody: raw, timestamp: null, signature: null }, env, NOW)).status).toBe(401);
    expect((await receiveEvent(db(), "production", signed(raw, NOW - 299), env, NOW)).status).toBe(200);
  });

  it("event_id مكرر: بيرجع نجاح بلا معالجة تانية", async () => {
    let calls = 0;
    registerEventHandler("test.started", async () => void calls++);
    const raw = event("test.started", `evt_${uniq()}`, { plan_id: "mb_1" });
    const env2 = { WEBHOOK_SECRET_MEDIABUYER: SECRET }; // scan:ok
    const a = await receiveEvent(db(), "mediabuyer", signed(raw, NOW), env2, NOW);
    const b = await receiveEvent(db(), "mediabuyer", signed(raw, NOW), env2, NOW);
    expect(a.body.status).toBe("ok");
    expect(b).toMatchObject({ status: 200, body: { status: "duplicate" } });
    expect(calls).toBe(1);
    expect(await db().inboundEvent.count({ where: { system: "mediabuyer", eventId: a.body.event_id as string } })).toBe(1);
  });

  it("نفس event_id بنظامين مختلفين مسموح (القيد لكل نظام)", async () => {
    const id = `evt_${uniq()}`;
    const a = await receiveEvent(db(), "production", signed(event("brief.accepted", id), NOW), env, NOW);
    const b = await receiveEvent(db(), "oms", signed(event("draft.activated", id), NOW), env, NOW);
    expect([a.body.status, b.body.status]).toEqual(["ok", "ok"]);
  });

  it("نوع حدث مش من أحداث النظام، أو غلاف ناقص، أو JSON تالف: مرفوض", async () => {
    expect((await receiveEvent(db(), "production", signed(event("test.started"), NOW), env, NOW)).status).toBe(422);
    const noId = JSON.stringify({ type: "brief.accepted", occurred_at: "2026-10-12T12:00:00+03:00", data: {} });
    expect((await receiveEvent(db(), "production", signed(noId, NOW), env, NOW)).status).toBe(422);
    expect((await receiveEvent(db(), "production", signed("{مش json", NOW), env, NOW)).status).toBe(400);
  });

  it("سر التوقيع مش مضبوط: بيرفض (503) بدل ما يقبل بلا فحص", async () => {
    const r = await receiveEvent(db(), "finance", signed(event("budget.updated"), NOW), {}, NOW);
    expect(r.status).toBe(503);
  });

  it("فشل المعالج بيتسجّل بالحدث وما بيكسر الاستقبال", async () => {
    registerEventHandler("brief.rejected", async () => {
      throw new Error("عطل المعالج");
    });
    const r = await receiveEvent(db(), "production", signed(event("brief.rejected"), NOW), env, NOW);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("recorded_with_error");
    const row = await db().inboundEvent.findFirstOrThrow({ where: { system: "production", eventId: r.body.event_id as string } });
    expect(row.error).toBe("عطل المعالج");
  });

  it("الحد: 20 حدث بالثانية، وبعدها 429 مع Retry-After", async () => {
    // بنفس اللحظة (مش واحد ورا واحد): تحت ضغط الاختبارات الموازية الحلقة التسلسلية بتتعدّى الثانية وما بتوصل الحد
    const results = await Promise.all(Array.from({ length: 30 }, () => receiveEvent(db(), "production", signed(event("brief.accepted"), NOW), env, NOW)));
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(1);
    expect(results.find((r) => r.status === 429)?.headers?.["retry-after"]).toBeTruthy();
  });

  describe("قواعد الادعاءات لكل منتج", () => {
    async function product() {
      const c = await db().candidate.create({ data: { titleAr: "زيت للاختبار " + uniq(), titleSrc: "x", lane: "manual", status: "deep_research" } });
      const pf = await db().productFile.create({ data: { candidateId: c.id, path: "ready_made", status: "draft", ownerId: "owner" } });
      return { c, pf };
    }

    it("منتج ما انفحص امتثاله = «يحتاج مراجعة» (مش ناجح)، والممنوعات والقواعد من المكتبات", async () => {
      const { pf } = await product();
      const v = (await buildCompliance(db(), pf.id))!;
      expect(validateShape(COMPLIANCE_RESPONSE, v)).toEqual([]);
      expect(v).toMatchObject({ product_ref: pf.id, classification: "needs_review", verdict: "needs_specialist", allowed_claims: [], references: [] });
      // اختبارات الامتثال بتضيف قواعد مؤقتة (بادئتها cmp) بنفس القاعدة وبنفس الوقت: بنعدّ المبذور بس
      expect(v.banned_claims.filter((p) => !p.startsWith("cmp")).length).toBe(16);
      expect(v.ad_rules.filter((r) => !r.startsWith("cmp")).length).toBe(10);
    });

    it("منتج بفحص: بيطلع التصنيف والحكم والادعاءات المسموحة، والنصوص المعتمدة بس", async () => {
      const { c, pf } = await product();
      // HER-01 (تراث) معتمد من البذور، وREF-01 (حديث) بانتظار المراجع الشرعي: ما منعدّل المكتبات المشتركة
      await db().complianceCheck.create({
        data: {
          candidateId: c.id, stage: "full", classification: "cosmetic", verdict: "pass_with_edits",
          checksJson: { allowed_claims: ["بيغذّي فروة الراس", "بيقوّي مظهر الشعر"], references: [{ code: "HER-01", usage: "عن المادة مش عن المنتج" }, { code: "REF-01", usage: "ممنوع" }] },
        },
      });
      const v = (await buildCompliance(db(), pf.id))!;
      expect(validateShape(COMPLIANCE_RESPONSE, v)).toEqual([]);
      expect(v).toMatchObject({ classification: "cosmetic", verdict: "pass_with_edits", allowed_claims: ["بيغذّي فروة الراس", "بيقوّي مظهر الشعر"] });
      expect(v.references.map((r) => r.code)).toEqual(["HER-01"]);
      expect(v.references[0].usage).toBe("عن المادة مش عن المنتج");
    });

    it("فحص «كامل» بيغلب «مبدئي»", async () => {
      const { c, pf } = await product();
      await db().complianceCheck.create({ data: { candidateId: c.id, stage: "full", classification: "cosmetic", verdict: "pass", checksJson: {} } });
      await db().complianceCheck.create({ data: { candidateId: c.id, stage: "screen", classification: "therapeutic", verdict: "fail", checksJson: {} } });
      expect((await buildCompliance(db(), pf.id))!).toMatchObject({ classification: "cosmetic", verdict: "pass" });
    });

    it("منتج مجهول: null (404 بالنقطة)، وتغيير ادعاء بيحدّث updated_at", async () => {
      expect(await buildCompliance(db(), "pf_no_such")).toBeNull();
      const { pf } = await product();
      const before = (await buildCompliance(db(), pf.id))!.updated_at;
      await new Promise((r) => setTimeout(r, 15));
      await db().claimRule.updateMany({ where: { phrase: { startsWith: "يشفي" } }, data: { reason: "ادعاء علاجي (محدّث)" } });
      const after = (await buildCompliance(db(), pf.id))!.updated_at;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
      await db().claimRule.updateMany({ where: { phrase: { startsWith: "يشفي" } }, data: { reason: "ادعاء علاجي" } });
    });
  });

  it("قراءة المرشحين: بالحالة والتاريخ، بالشكل المكتوب بالعقد", async () => {
    const stamp = uniq();
    const p = await db().problem.findFirstOrThrow({ where: { nameAr: "تساقط الشعر" } });
    const c = await db().candidate.create({ data: { titleAr: "مرشح " + stamp, titleSrc: "x", lane: "manual", status: "deep_research", velocityScore: 66, dnaScore: 78, problemId: p.id } });
    const items = await listCandidatesFor(db(), { status: "deep_research", since: "2026-01-01" });
    const mine = items.find((i) => i.id === c.id)!;
    expect(mine).toMatchObject({ title_ar: "مرشح " + stamp, problem: "تساقط الشعر", velocity: 66, dna: 78, status: "deep_research" });
    expect(mine.link).toContain(`/candidates/${c.id}`);
    expect((await listCandidatesFor(db(), { status: "scanned" })).find((i) => i.id === c.id)).toBeUndefined();
    expect((await listCandidatesFor(db(), { since: "2999-01-01" })).length).toBe(0);
    await expect(listCandidatesFor(db(), { since: "مش تاريخ" })).rejects.toThrow();
  });
});
