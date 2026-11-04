// إدخال ملاحظات المصدر: كل ملاحظة بالرابط والتاريخ ونوع الوصول والثقة، بلا تكرار، ومرشح لكل منتج (الدمج الذكي بيجي مع B11).
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { raiseAlert } from "@/lib/alerts";
import { getSetting } from "@/lib/settings";
import { type Draft } from "./mapping";
import { DEFAULT_TRUST, trustLevel, trustOf, type AccessMethod } from "./trust";

export type Lane = "china_early" | "regional_proven" | "manual";

export const SOURCE_PRESETS = {
  douyin: { label: "منصة بيانات دويين (مرخّصة)", lane: "china_early" as Lane, access: "licensed" as AccessMethod },
  ads_tool: { label: "أداة إعلانات مرخّصة", lane: "regional_proven" as Lane, access: "licensed" as AccessMethod },
  google_trends: { label: "جوجل ترند (ملف)", lane: "regional_proven" as Lane, access: "import" as AccessMethod },
  keyword_planner: { label: "مخطط الكلمات (ملف)", lane: "regional_proven" as Lane, access: "import" as AccessMethod },
  kimi: { label: "نتيجة Kimi (JSON)", lane: "china_early" as Lane, access: "kimi" as AccessMethod },
  generic: { label: "ملف عام", lane: "manual" as Lane, access: "import" as AccessMethod },
} as const;
export type PresetId = keyof typeof SOURCE_PRESETS;

export interface DraftEx extends Draft {
  titleAr?: string | null;
  sourceNote?: string | null;
  adCountries?: string[] | null;
}

export interface IngestContext {
  source: string;
  access: AccessMethod;
  lane: Lane;
  capturedBy?: string | null;
  fileKey?: string | null;
}

export interface IngestResult {
  candidatesCreated: number;
  observationsCreated: number;
  duplicates: number;
}

export async function loadTrustTable(db: PrismaClient): Promise<Record<AccessMethod, number>> {
  const s = await getSetting(db, "sources.trust");
  const items = (s?.value as { items?: Partial<Record<AccessMethod, number>> } | undefined)?.items ?? {};
  return { ...DEFAULT_TRUST, ...items };
}

export const dedupeHashOf = (source: string, d: { url: string | null; title: string; capturedAt: string | null }) =>
  createHash("sha256").update(`${source}|${(d.url ?? d.title).toLowerCase()}|${d.capturedAt ?? ""}`).digest("hex");

export async function ingestDrafts(db: PrismaClient, drafts: DraftEx[], ctx: IngestContext): Promise<IngestResult> {
  const trustTable = await loadTrustTable(db);
  const trustValue = trustOf(ctx.access, trustTable);
  const problems = await db.problem.findMany({ select: { id: true, nameAr: true } });
  const res: IngestResult = { candidatesCreated: 0, observationsCreated: 0, duplicates: 0 };

  for (const d of drafts) {
    const hash = dedupeHashOf(ctx.source, d);
    const dup = await db.observation.findFirst({ where: { dedupeHash: hash }, select: { id: true } });
    if (dup) {
      res.duplicates += 1;
      continue;
    }
    const titleSrc = d.title;
    // نفس المنتج (بنفس العنوان الأصلي) بيروح لنفس المرشح. الدمج الأذكى (بصمة الصورة والتضمين) بـ B11.
    let cand = await db.candidate.findFirst({ where: { titleSrc: { equals: titleSrc, mode: "insensitive" }, deletedAt: null } });
    if (!cand) {
      const problem = d.problem ? problems.find((p) => p.nameAr === d.problem) : undefined;
      cand = await db.candidate.create({ data: { titleAr: d.titleAr || titleSrc, titleSrc, lane: ctx.lane, problemId: problem?.id ?? null } });
      res.candidatesCreated += 1;
    }
    const capturedAt = d.capturedAt ? new Date(`${d.capturedAt}T00:00:00Z`) : new Date();
    const obs = await db.observation.create({
      data: {
        candidateId: cand.id,
        source: ctx.source,
        accessMethod: ctx.access,
        url: d.url,
        market: d.market,
        capturedAt,
        capturedBy: ctx.capturedBy ?? null,
        snapshotKey: ctx.fileKey ?? null,
        extractedJson: { title: d.title, imageUrl: d.imageUrl, problem: d.problem, trustValue, sourceNote: d.sourceNote ?? null } as never,
        signalsJson: { trendAgeDays: d.trendAgeDays } as never,
        price: d.price === null ? null : new Prisma.Decimal(d.price),
        currency: d.currency,
        sales: d.sales,
        reviews: d.reviews,
        rating: d.rating,
        listingAgeDays: d.listingAgeDays,
        adStartDate: d.adStartDate ? new Date(`${d.adStartDate}T00:00:00Z`) : null,
        adVersions: d.adVersions,
        adCountries: d.adCountries?.length ? (d.adCountries as never) : Prisma.JsonNull,
        advertisersInMarket: d.advertisersInMarket,
        creators: d.creators,
        newCreators7d: d.newCreators7d,
        newCreatorsPrev7d: d.newCreatorsPrev7d,
        intentComments: d.intentComments,
        skepticComments: d.skepticComments,
        commentSample: d.commentSample === null ? Prisma.JsonNull : ({ size: d.commentSample } as never), // العدّ بس، بلا نص ولا أسماء
        engagementRate: d.engagementRate,
        yellowCartShare: d.yellowCartShare,
        cumulativeSales: d.cumulativeSales,
        trust: trustLevel(trustValue),
        dedupeHash: hash,
      },
    });
    res.observationsCreated += 1;
    if (d.imageUrl) await db.imageAsset.create({ data: { candidateId: cand.id, observationId: obs.id, storageKey: "pending", sourceUrl: d.imageUrl } });
    const distinct = await db.observation.findMany({ where: { candidateId: cand.id }, distinct: ["source"], select: { source: true } });
    await db.candidate.update({ where: { id: cand.id }, data: { lastSeenAt: new Date(), sourcesCount: distinct.length } });
  }
  return res;
}

// سجل نجاح أو فشل لكل سحب أو استيراد (جدول ImportJob). فشل كامل = تنبيه بدل صفر صامت.
export async function recordJob(
  db: PrismaClient,
  j: { source: string; fileKey: string; mapping: unknown; rows: number; ok: number; failed: number; errors?: { row: number; reason: string }[] },
) {
  const status = j.rows === 0 ? "empty" : j.ok === 0 && j.failed > 0 ? "failed" : j.failed > 0 ? "partial" : "done";
  const row = await db.importJob.create({
    data: { source: j.source, fileKey: j.fileKey, mappingJson: { mapping: j.mapping, errors: (j.errors ?? []).slice(0, 50) } as never, rows: j.rows, ok: j.ok, failed: j.failed, status },
  });
  if (status === "failed") raiseAlert({ type: "source_failed", severity: "warning", message: `المصدر ${j.source} فشل: ${j.failed} من ${j.rows}${j.errors?.[0] ? ` (${j.errors[0].reason})` : ""}` });
  return { ...row, status };
}
