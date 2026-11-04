import { apiError, guard } from "@/lib/api-guard";
import { getDb } from "@/lib/db";
import { extensionErrorResponse } from "@/extension/devices";
import { activateVersion, listSets, publishSet } from "@/extension/selectors";

export const dynamic = "force-dynamic";

export const GET = guard("dashboard.view", async () => Response.json({ items: await listSets(getDb()) }));

// نشر نسخة محددات جديدة (المالك والنائب): بتصير الفعّالة، والإضافات بتاخدها بالتحديث الجاي بلا إعادة تثبيت
export const POST = guard("settings.manage", async ({ req, audit }) => {
  try {
    const body = await req.json().catch(() => null);
    const v = await publishSet(getDb(), body);
    audit("SelectorSet", `${v.site}@${v.version}`, null, { site: v.site, version: v.version });
    return Response.json(v, { status: 201 });
  } catch (e) {
    return extensionErrorResponse(e);
  }
});

// رجوع لنسخة قديمة: { site, version }
export const PATCH = guard("settings.manage", async ({ req, audit }) => {
  try {
    const b = (await req.json().catch(() => null)) as { site?: unknown; version?: unknown } | null;
    if (typeof b?.site !== "string" || !Number.isInteger(b.version)) return apiError(400, "bad_request", "site وversion مطلوبين");
    const v = await activateVersion(getDb(), b.site, b.version as number);
    audit("SelectorSet", `${v.site}@${v.version}`, null, { active: true });
    return Response.json(v);
  } catch (e) {
    return extensionErrorResponse(e);
  }
});
