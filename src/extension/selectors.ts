// ملفات المحددات عن بُعد: نسخ مرقّمة، نسخة فعّالة واحدة لكل موقع، رجوع لنسخة قديمة، وتحديث الإضافة بلا إعادة تثبيت.
// أمان: الخادم بيقبل بس مواقع مدعومة (الإضافة أصلاً صلاحياتها لهالمواقع بس). محدد غلط ما بيدخل.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { ExtensionError } from "./devices";

// الموقع ← النطاقات المسموحة. مواقع B14 بتنضاف هون لما تنبني محوّلاتها وصلاحياتها بالإضافة
export const SITE_HOSTS: Record<string, string[]> = {
  aliexpress: ["aliexpress.com", "aliexpress.us"],
  meta_adlib: ["facebook.com"],
};
export const SITE_LABELS_AR: Record<string, string> = { aliexpress: "علي إكسبرس", meta_adlib: "مكتبة إعلانات ميتا" };

const READS = /^(text|src|href|content|attr:[A-Za-z][\w-]{0,40})$/;
const PARSES = ["money", "int", "float", "ratio", "none"];
const MAX_BYTES = 20_000;

const bad = (m: string) => new ExtensionError(400, "bad_request", m);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const strArr = (v: unknown, f: string, max = 20, len = 300): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || !x.trim() || x.length > len)) throw bad(`${f}: قائمة نصوص (حتى ${max})`);
  return v as string[];
};

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
export const hostAllowed = (site: string, host: string) => (SITE_HOSTS[site] ?? []).some((h) => host === h || host.endsWith(`.${h}`));

function validField(name: string, spec: unknown) {
  if (!isObj(spec)) throw bad(`الحقل ${name}: لازم كائن`);
  if (typeof spec.css !== "string" || !spec.css.trim() || spec.css.length > 400) throw bad(`الحقل ${name}: المحدد (css) مطلوب`);
  if (spec.read !== undefined && (typeof spec.read !== "string" || !READS.test(spec.read))) throw bad(`الحقل ${name}: read غلط`);
  if (spec.parse !== undefined && !PARSES.includes(String(spec.parse))) throw bad(`الحقل ${name}: parse غلط`);
  if (spec.regex !== undefined) {
    if (typeof spec.regex !== "string" || spec.regex.length > 200) throw bad(`الحقل ${name}: regex غلط`);
    try {
      new RegExp(spec.regex);
    } catch {
      throw bad(`الحقل ${name}: regex مش صحيح`);
    }
  }
  return spec;
}

/** تحقق كامل من ملف محددات. بيرمي ExtensionError بالعربي */
export function validateSelectorSet(raw: unknown): Record<string, unknown> & { site: string } {
  if (!isObj(raw)) throw bad("الملف لازم كائن JSON");
  if (JSON.stringify(raw).length > MAX_BYTES) throw bad("الملف أكبر من 20 كيلو");
  const site = String(raw.site ?? "");
  if (!(site in SITE_HOSTS)) throw bad(`موقع غير مدعوم: ${site || "—"} (المدعوم: ${Object.keys(SITE_HOSTS).join(" · ")})`);
  const match = strArr(raw.match, "match");
  if (!match.length) throw bad("match: لازم نمط رابط واحد على الأقل");
  for (const p of match) {
    const m = /^https:\/\/([^/]+)\//.exec(p);
    const host = m?.[1].replace(/^\*\./, "").toLowerCase();
    if (!host || host.includes("*") || !hostAllowed(site, host)) throw bad(`النمط ${p}: خارج المواقع المدعومة لـ${site}`);
  }
  if (!isObj(raw.fields) || !Object.keys(raw.fields).length) throw bad("fields: مطلوبة");
  for (const [k, v] of Object.entries(raw.fields)) validField(k, v);
  const required = strArr(raw.required, "required", 10, 40);
  for (const r of required) if (!(r in (raw.fields as object))) throw bad(`required: الحقل ${r} مش معرّف بـfields`);
  const stop = raw.stop === undefined ? {} : raw.stop;
  if (!isObj(stop)) throw bad("stop: لازم كائن");
  strArr(stop.css, "stop.css");
  strArr(stop.text, "stop.text");
  strArr(stop.url, "stop.url");
  if (raw.list !== undefined) {
    const l = raw.list;
    if (!isObj(l) || typeof l.item !== "string" || !isObj(l.fields)) throw bad("list: لازم item وfields");
    for (const [k, v] of Object.entries(l.fields)) validField(`list.${k}`, v);
  }
  if (raw.comments !== undefined && (typeof raw.comments !== "string" || raw.comments.length > 400)) throw bad("comments: محدد نصي");
  return { ...raw, site };
}

let defaultsCache: Record<string, unknown>[] | null = null;
export function loadDefaults(dir = join(process.cwd(), "extension", "selectors")): Record<string, unknown>[] {
  if (defaultsCache && dir.endsWith("selectors")) return defaultsCache;
  const out = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => validateSelectorSet(JSON.parse(readFileSync(join(dir, f), "utf8"))));
  if (dir.endsWith("selectors")) defaultsCache = out;
  return out;
}

/** أول طلب: النسخ المرفقة بالإضافة بتنزرع كنسخة 1 فعّالة لكل موقع ما إله نسخة */
export async function ensureDefaults(db: PrismaClient): Promise<void> {
  for (const d of loadDefaults()) {
    const site = d.site as string;
    if (await db.selectorSet.findFirst({ where: { site }, select: { id: true } })) continue;
    await db.selectorSet.create({ data: { site, version: Number(d.version) || 1, selectorsJson: d as never, active: true } }).catch(() => null); // سباق طلبين: القيد الفريد بيحمي
  }
}

export interface SetView {
  site: string;
  version: number;
  active: boolean;
  createdAt: string;
  selectors: Record<string, unknown>;
}
const view = (r: { site: string; version: number; active: boolean; createdAt: Date; selectorsJson: unknown }): SetView => ({ site: r.site, version: r.version, active: r.active, createdAt: r.createdAt.toISOString(), selectors: r.selectorsJson as Record<string, unknown> });

/** النسخ الفعّالة الأحدث من اللي الإضافة تعرفها: known = { aliexpress: 1 } */
export async function activeSets(db: PrismaClient, known: Record<string, number> = {}): Promise<SetView[]> {
  await ensureDefaults(db);
  const rows = await db.selectorSet.findMany({ where: { active: true }, orderBy: { site: "asc" } });
  return rows.filter((r) => r.version !== known[r.site]).map(view);
}

export async function listSets(db: PrismaClient): Promise<SetView[]> {
  await ensureDefaults(db);
  return (await db.selectorSet.findMany({ orderBy: [{ site: "asc" }, { version: "desc" }], take: 200 })).map(view);
}

/** نسخة جديدة (رقمها التالي) وبتصير الفعّالة، والقديمة بتضل للرجوع */
export async function publishSet(db: PrismaClient, raw: unknown): Promise<SetView> {
  const valid = validateSelectorSet(raw);
  await ensureDefaults(db);
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await db.selectorSet.findFirst({ where: { site: valid.site }, orderBy: { version: "desc" } });
    const version = (last?.version ?? 0) + 1;
    try {
      const [, row] = await db.$transaction([
        db.selectorSet.updateMany({ where: { site: valid.site, active: true }, data: { active: false } }),
        db.selectorSet.create({ data: { site: valid.site, version, selectorsJson: { ...valid, version } as never, active: true } }),
      ]);
      return view(row);
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
  throw new ExtensionError(409, "conflict", "تعارض بالنشر، أعد المحاولة");
}

export async function activateVersion(db: PrismaClient, site: string, version: number): Promise<SetView> {
  const row = await db.selectorSet.findUnique({ where: { site_version: { site, version } } });
  if (!row) throw new ExtensionError(404, "not_found", "النسخة مش موجودة");
  await db.$transaction([db.selectorSet.updateMany({ where: { site, active: true }, data: { active: false } }), db.selectorSet.update({ where: { id: row.id }, data: { active: true } })]);
  return view({ ...row, active: true });
}

/** قاموس نية الشراء والتشكيك للإضافة: بتعدّ فيه محلياً وبترسل العدد بس */
export async function lexicon(db: PrismaClient) {
  const get = async (key: string) => {
    const s = await db.setting.findFirst({ where: { key }, orderBy: { version: "desc" } });
    const items = ((s?.valueJson as { items?: { lang: string; words: string[] }[] } | null)?.items ?? []) as { lang: string; words: string[] }[];
    return items.flatMap((i) => (Array.isArray(i.words) ? i.words : [])).filter((w) => typeof w === "string");
  };
  return { intent: await get("signals.intent_words"), skeptic: await get("signals.skeptic_words") };
}
