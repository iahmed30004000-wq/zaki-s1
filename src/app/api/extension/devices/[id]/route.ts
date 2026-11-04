import { can } from "@/core/permissions";
import { guard } from "@/lib/api-guard";
import { getDb } from "@/lib/db";
import { extensionErrorResponse, revokeDevice } from "@/extension/devices";

export const dynamic = "force-dynamic";

// إلغاء جهاز (فوري): التوكن بيوقف يشتغل. الباحث بيلغي جهازه بس.
export const DELETE = guard<{ id: string }>("capture.create", async ({ params, user, audit }) => {
  try {
    const d = await revokeDevice(getDb(), params.id, can(user.role, "settings.manage") ? {} : { userSub: user.sub });
    audit("ExtensionDevice", d.id, { active: true }, { active: false });
    return Response.json(d);
  } catch (e) {
    return extensionErrorResponse(e);
  }
});
