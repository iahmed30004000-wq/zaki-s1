import { getDb } from "@/lib/db";
import { withDevice } from "@/extension/device-route";
import { activeSets } from "@/extension/selectors";

export const dynamic = "force-dynamic";

// عام عن قصد: محمي بتوكن الجهاز. المحددات الفعّالة الأحدث من اللي الإضافة تعرفها (?known={"aliexpress":1}): تحديث بلا إعادة تثبيت.
export const GET = withDevice(async ({ req }) => {
  let known: Record<string, number> = {};
  try {
    const raw = JSON.parse(new URL(req.url).searchParams.get("known") ?? "{}");
    if (raw && typeof raw === "object") known = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "number")) as Record<string, number>;
  } catch {
    /* known غلط: بنرجّع الكل */
  }
  return Response.json({ sets: await activeSets(getDb(), known) });
});
