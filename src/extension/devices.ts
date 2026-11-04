// أجهزة الإضافة: توكن لكل جهاز بيظهر مرة وحدة، والخادم بيحفظ بصمته (SHA-256) بس. الإلغاء فوري.
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";

export class ExtensionError extends Error {
  constructor(public status: 400 | 401 | 404 | 409 | 429, public code: string, message: string) {
    super(message);
  }
}
export function extensionErrorResponse(e: unknown): Response {
  if (e instanceof ExtensionError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  throw e;
}

export const TOKEN_PREFIX = "s1x_";
export const MAX_DEVICES_PER_USER = 10;
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export interface DeviceView {
  id: string;
  name: string;
  owner: string;
  active: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

export async function createDevice(db: PrismaClient, userSub: string, nameRaw: unknown): Promise<DeviceView & { token: string }> {
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (name.length < 2 || name.length > 60) throw new ExtensionError(400, "bad_request", "اسم الجهاز بين حرفين و60 حرف");
  const user = await db.user.findUnique({ where: { oidcSub: userSub } });
  if (!user || !user.active) throw new ExtensionError(400, "bad_request", "المستخدم مش موجود");
  const count = await db.extensionDevice.count({ where: { userId: user.id, active: true } });
  if (count >= MAX_DEVICES_PER_USER) throw new ExtensionError(409, "conflict", `وصلت الحد (${MAX_DEVICES_PER_USER} أجهزة فعّالة): ألغِ جهاز قديم أول`);
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const row = await db.extensionDevice.create({ data: { userId: user.id, name, tokenHash: hashToken(token) } });
  return { id: row.id, name: row.name, owner: user.nameAr, active: true, lastSeenAt: null, createdAt: row.createdAt.toISOString(), token };
}

export async function listDevices(db: PrismaClient, opts: { userSub?: string } = {}): Promise<DeviceView[]> {
  const user = opts.userSub ? await db.user.findUnique({ where: { oidcSub: opts.userSub } }) : null;
  const rows = await db.extensionDevice.findMany({ where: opts.userSub ? { userId: user?.id ?? "none" } : {}, include: { user: { select: { nameAr: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map((r) => ({ id: r.id, name: r.name, owner: r.user.nameAr, active: r.active, lastSeenAt: r.lastSeenAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
}

export async function revokeDevice(db: PrismaClient, id: string, opts: { userSub?: string } = {}): Promise<DeviceView> {
  const row = await db.extensionDevice.findUnique({ where: { id }, include: { user: { select: { nameAr: true, oidcSub: true } } } });
  if (!row || (opts.userSub && row.user.oidcSub !== opts.userSub)) throw new ExtensionError(404, "not_found", "الجهاز مش موجود");
  const u = await db.extensionDevice.update({ where: { id }, data: { active: false } });
  return { id: u.id, name: u.name, owner: row.user.nameAr, active: false, lastSeenAt: u.lastSeenAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() };
}

export interface AuthedDevice {
  id: string;
  name: string;
  userId: string;
}

// توكن الجهاز من هيدر Authorization. بيرجع null لو غلط أو ملغي أو صاحبه موقوف
export async function authenticateDevice(db: PrismaClient, authHeader: string | null, now: Date = new Date()): Promise<AuthedDevice | null> {
  const m = /^Bearer\s+(s1x_[A-Za-z0-9_-]{20,100})$/.exec(authHeader ?? "");
  if (!m) return null;
  const row = await db.extensionDevice.findUnique({ where: { tokenHash: hashToken(m[1]) }, include: { user: { select: { active: true, deletedAt: true } } } });
  if (!row || !row.active || !row.user.active || row.user.deletedAt) return null;
  if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > 60_000) await db.extensionDevice.update({ where: { id: row.id }, data: { lastSeenAt: now } });
  return { id: row.id, name: row.name, userId: row.userId };
}
