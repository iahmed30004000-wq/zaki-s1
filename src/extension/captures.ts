// استقبال لقطات الإضافة: تحقق صارم، تنظيف النصوص (إيميلات وهواتف)، حفظ كمرشح، واستخراج احتياطي على الخادم لو الحقول ناقصة.
// التعليقات ما بتوصل خام: العدد بس. الأرقام من الإضافة ما بتنقلب، والمستخرجة بالوكيل لازم تكون موجودة حرفياً بنص الصفحة.
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { raiseAlert } from "@/lib/alerts";
import { scrub } from "@/sources/mapping";
import { dedupeHashOf, ingestDrafts, type DraftEx, type Lane } from "@/sources/ingest";
import type { AgentRunner } from "@/compliance/service";
import { ExtensionError, type AuthedDevice } from "./devices";
import { SITE_HOSTS, SITE_LABELS_AR, hostAllowed, hostOf } from "./selectors";

export const MAX_ITEMS = 20;
export const MAX_PAGE_TEXT = 15_000;
export const HOURLY_CAP = 120; // سقف الخادم لكل جهاز (الإضافة نفسها 40 بالساعة): حماية لو انسرق توكن
const LANES: Record<string, Lane> = { aliexpress: "manual", meta_adlib: "regional_proven" };
const FALLBACK_AGENT: Record<string, "A01" | "A03"> = { aliexpress: "A01", meta_adlib: "A03" };

const bad = (m: string) => new ExtensionError(400, "bad_request", m);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return null;
  const t = scrub(v).replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
};
const int = (v: unknown, max = 1e10): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

export interface CleanItem {
  title: string | null;
  price: string | null;
  currency: string | null;
  sales: number | null;
  reviews: number | null;
  rating: number | null;
  imageUrl: string | null;
  page: string | null;
  adStartDate: string | null;
  adVersions: number | null;
  adCountries: string[] | null;
  pageText: string | null;
}
export interface CleanCapture {
  site: string;
  url: string;
  market: string | null;
  note: string | null;
  mode: "page" | "list";
  counts: { intent: number; skeptic: number; sample: number } | null;
  items: CleanItem[];
}

function httpsUrl(v: unknown, max = 600): string | null {
  if (typeof v !== "string" || v.length > max) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function validateCapture(raw: unknown): CleanCapture {
  if (!isObj(raw)) throw bad("الطلب ناقص");
  const site = String(raw.site ?? "");
  if (!(site in SITE_HOSTS)) throw bad(`موقع غير مدعوم: ${site || "—"}`);
  const url = httpsUrl(raw.url);
  const host = url ? hostOf(url) : null;
  if (!url || !host || !hostAllowed(site, host)) throw bad("رابط الصفحة خارج المواقع المدعومة");
  const market = typeof raw.market === "string" && raw.market ? raw.market.toUpperCase() : null;
  if (market && !/^[A-Z]{2}$/.test(market)) throw bad("السوق لازم رمز حرفين");
  if (!Array.isArray(raw.items) || !raw.items.length) throw bad("ما في عناصر للحفظ");
  if (raw.items.length > MAX_ITEMS) throw bad(`حتى ${MAX_ITEMS} عنصر بالطلب`);
  let counts: CleanCapture["counts"] = null;
  if (raw.counts !== undefined && raw.counts !== null) {
    const c = raw.counts as Record<string, unknown>;
    const sample = int(c.sample, 100_000);
    const intent = int(c.intent, 100_000);
    const skeptic = int(c.skeptic, 100_000);
    if (sample === null || intent === null || skeptic === null || intent > sample || skeptic > sample) throw bad("عدّ التعليقات غلط (العدد لازم أقل من حجم العيّنة)");
    counts = { sample, intent, skeptic };
  }
  const items = (raw.items as unknown[]).map((it): CleanItem => {
    if (!isObj(it)) throw bad("عنصر غلط");
    const f = isObj(it.fields) ? it.fields : {};
    const price = typeof f.price === "string" && /^\d{1,9}(\.\d{1,4})?$/.test(f.price) ? f.price : null;
    const date = typeof f.adStartDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.adStartDate) && !Number.isNaN(Date.parse(f.adStartDate)) ? f.adStartDate : null;
    return {
      title: text(f.title, 200),
      price,
      currency: typeof f.currency === "string" && /^[A-Z]{3}$/.test(f.currency) ? f.currency : null,
      sales: int(f.sales),
      reviews: int(f.reviews),
      rating: num(f.rating, 0, 5),
      imageUrl: httpsUrl(f.imageUrl),
      page: text(f.page, 120),
      adStartDate: date,
      adVersions: int(f.adVersions, 100_000),
      adCountries: Array.isArray(f.adCountries) ? f.adCountries.map((c) => text(c, 40)).filter((c): c is string => Boolean(c)).slice(0, 30) : null,
      pageText: text(typeof it.pageText === "string" ? it.pageText : null, MAX_PAGE_TEXT),
    };
  });
  return { site, url, market, note: text(raw.note, 300), mode: raw.mode === "queue" || items.length > 1 ? "list" : "page", counts, items };
}

// ───── الاستخراج الاحتياطي: A01 لصفحات المنتجات و A03 لمكتبة الإعلانات ─────
const digits = (s: string) => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[,\s]/g, "");
// الرقم لازم يكون موجود حرفياً بنص الصفحة (بوابة الجودة): غير هيك بيتجاهل ولا بنخمّن
const inText = (n: number | null, haystack: string): boolean => n !== null && (digits(haystack).includes(String(n)) || new RegExp(`\\b${n}\\b`).test(haystack));

export async function extractFallback(db: PrismaClient, site: string, url: string, item: CleanItem, run: AgentRunner): Promise<Partial<CleanItem> | null> {
  const code = FALLBACK_AGENT[site];
  const textBody = item.pageText;
  if (!code || !textBody) return null;
  let out: Record<string, unknown> | null = null;
  try {
    const vars = code === "A01" ? { site, url, page_text: textBody, images: item.imageUrl ? [item.imageUrl] : [], captured_at: new Date().toISOString().slice(0, 10) } : { ad: textBody, market: "غير محدد", platform: "meta" };
    const r = await run(db, code, vars, { inputRef: `ext:${site}:${url}` });
    out = isObj(r.output) ? r.output : null;
  } catch {
    return null; // الوكيل متوقف: بتضل «ناقصة» ومسجّلة
  }
  if (!out) return null;
  const found: Partial<CleanItem> = {};
  if (code === "A01") {
    const title = typeof out.title_src === "string" ? text(out.title_src, 200) : null;
    if (title && textBody.toLowerCase().includes(title.toLowerCase().slice(0, 30))) found.title = title;
    const price = typeof out.price === "number" && inText(out.price, textBody.replace(/\.\d+/g, "")) ? out.price.toFixed(2) : null;
    if (price) found.price = price;
    if (typeof out.currency === "string" && /^[A-Z]{3}$/.test(out.currency)) found.currency = out.currency;
    for (const k of ["sales", "reviews"] as const) {
      const v = int(out[k]);
      if (inText(v, textBody)) found[k] = v;
    }
  } else {
    const product = typeof out.product === "string" ? text(out.product, 200) : null;
    if (product) found.title = product;
    if (typeof out.start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(out.start_date)) found.adStartDate = out.start_date;
    const versions = int(out.versions, 100_000);
    if (versions !== null) found.adVersions = versions;
    if (Array.isArray(out.countries)) found.adCountries = out.countries.map((c) => text(c, 40)).filter((c): c is string => Boolean(c)).slice(0, 30);
  }
  return Object.keys(found).length ? found : null;
}

export interface SaveResult {
  saved: number;
  duplicates: number;
  failed: number;
  jobs: { status: "ok" | "duplicate" | "needs_extraction"; candidateTitle?: string; error?: string }[];
}

export async function saveCapture(db: PrismaClient, device: AuthedDevice, raw: unknown, deps: { runAgent?: AgentRunner; now?: Date } = {}): Promise<SaveResult> {
  const now = deps.now ?? new Date();
  const cap = validateCapture(raw);
  const recent = await db.captureJob.count({ where: { deviceId: device.id, createdAt: { gt: new Date(now.getTime() - 3_600_000) } } });
  if (recent + cap.items.length > HOURLY_CAP) throw new ExtensionError(429, "rate_limited", "الجهاز تعدّى حد الساعة بالخادم: استنى شوي");
  const runner = deps.runAgent ?? (async (...args) => (await import("@/agents/service")).runAgent(args[0], args[1], args[2], args[3]));
  const result: SaveResult = { saved: 0, duplicates: 0, failed: 0, jobs: [] };
  const today = now.toISOString().slice(0, 10);

  for (const original of cap.items) {
    let item = original;
    if (!item.title || (cap.site === "aliexpress" && !item.price)) {
      const fb = await extractFallback(db, cap.site, cap.url, item, runner);
      if (fb) item = { ...item, ...Object.fromEntries(Object.entries(fb).filter(([, v]) => v !== null && v !== undefined)) } as CleanItem;
    }
    const job = { deviceId: device.id, site: cap.site, url: cap.url, mode: cap.mode } as const;
    if (!item.title) {
      await db.captureJob.create({ data: { ...job, status: "needs_extraction", error: "العنوان ناقص: المحددات بدها تحديث أو الاستخراج الاحتياطي متوقف" } });
      result.failed += 1;
      result.jobs.push({ status: "needs_extraction", error: "العنوان ناقص" });
      continue;
    }
    // صفحة قائمة: كل بطاقة ببصمتها (وإلا نفس الرابط بيخلّي الكل «مكرر»)
    const itemUrl = cap.items.length > 1 ? `${cap.url}#${createHash("sha1").update(item.title).digest("hex").slice(0, 10)}` : cap.url;
    const draft: DraftEx = {
      title: item.title, url: itemUrl, market: cap.market, capturedAt: today, price: item.price, currency: item.currency, sales: item.sales, reviews: item.reviews, rating: item.rating,
      listingAgeDays: null, trendAgeDays: null, adStartDate: item.adStartDate, adVersions: item.adVersions, advertisersInMarket: null, creators: null, newCreators7d: null, newCreatorsPrev7d: null,
      intentComments: cap.counts?.intent ?? null, skepticComments: cap.counts?.skeptic ?? null, commentSample: cap.counts?.sample ?? null, engagementRate: null, yellowCartShare: null, cumulativeSales: null,
      imageUrl: item.imageUrl, problem: null, sourceNote: [cap.note, item.page ? `الصفحة: ${item.page}` : null].filter(Boolean).join(" — ") || null, adCountries: item.adCountries,
    };
    // قائمة بلا رابط خاص بكل عنصر: العنوان بيدخل بالبصمة عشان ما يندمج كل شي بواحد
    const source = `ext_${cap.site}`;
    const r = await ingestDrafts(db, [draft], { source, access: "extension", lane: LANES[cap.site] ?? "manual", capturedBy: device.id });
    const obs = await db.observation.findFirst({ where: { dedupeHash: dedupeHashOf(source, { url: itemUrl, title: item.title, capturedAt: today }) }, select: { id: true } });
    if (r.duplicates > 0) {
      result.duplicates += 1;
      await db.captureJob.create({ data: { ...job, status: "duplicate", observationId: obs?.id ?? null } });
      result.jobs.push({ status: "duplicate", candidateTitle: item.title });
    } else {
      result.saved += 1;
      await db.captureJob.create({ data: { ...job, status: "ok", observationId: obs?.id ?? null } });
      result.jobs.push({ status: "ok", candidateTitle: item.title });
    }
  }
  return result;
}

// إشارة توقف من الإضافة (كابتشا · تحقق · دخول) أو «المحددات بدها تحديث»: تنبيه + سجل
export async function recordEvent(db: PrismaClient, device: AuthedDevice, raw: unknown, now: Date = new Date()) {
  if (!isObj(raw)) throw bad("الطلب ناقص");
  const type = raw.type;
  if (type !== "stopped" && type !== "selectors_stale") throw bad("نوع الحدث غلط");
  const site = typeof raw.site === "string" && raw.site in SITE_HOSTS ? raw.site : "queue";
  const reason = text(raw.reason, 200) ?? "";
  const url = httpsUrl(raw.url) ?? "";
  const label = SITE_LABELS_AR[site] ?? "القائمة";
  await db.captureJob.create({ data: { deviceId: device.id, site, url: url || "-", mode: "page", status: type === "stopped" ? "stopped" : "selectors_stale", error: reason || null } });
  const message = type === "stopped" ? `الإضافة (${device.name}) وقفت على ${label}: الصفحة طالبة تحقق. حلّها بإيدك وكبس استئناف.` : `الإضافة (${device.name}): المحددات بدها تحديث (${label}) بعد 3 فشل متتالي.`;
  // نفس الرسالة المفتوحة ما بتنكرر
  const open = await db.alert.findFirst({ where: { type: "extension_stopped", message, ackAt: null }, select: { id: true } });
  if (!open) raiseAlert({ type: "extension_stopped", severity: "warning", message, link: "/extension" }, now);
  return { ok: true };
}
