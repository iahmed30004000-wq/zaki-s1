import { can } from "@/core/permissions";
import { guard } from "@/lib/api-guard";
import { getDb } from "@/lib/db";
import { createDevice, extensionErrorResponse, listDevices } from "@/extension/devices";

export const dynamic = "force-dynamic";

// أجهزة الإضافة: المالك والنائب بيشوفوا الكل، والباحث جهازه بس
export const GET = guard("capture.create", async ({ user }) => Response.json({ items: await listDevices(getDb(), can(user.role, "settings.manage") ? {} : { userSub: user.sub }) }));

// «جهاز جديد»: التوكن بيطلع بالرد مرة وحدة بس (الخادم بيحفظ بصمته)
export const POST = guard("capture.create", async ({ req, user, audit }) => {
  try {
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    const d = await createDevice(getDb(), user.sub, body?.name);
    audit("ExtensionDevice", d.id, null, { name: d.name }); // التوكن ما بينكتب بالتدقيق
    return Response.json(d, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return extensionErrorResponse(e);
  }
});
