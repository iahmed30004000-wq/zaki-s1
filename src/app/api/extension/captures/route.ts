import { getDb } from "@/lib/db";
import { saveCapture } from "@/extension/captures";
import { jsonBody, withDevice } from "@/extension/device-route";

export const dynamic = "force-dynamic";

// عام عن قصد: محمي بتوكن الجهاز (مش بجلسة موظف). استقبال لقطات الإضافة: تحقق صارم، والتعليقات عدد بس.
export const POST = withDevice(async ({ req, device }) => {
  const r = await saveCapture(getDb(), device, await jsonBody(req));
  return Response.json(r, { status: r.saved || r.duplicates ? 200 : 422 });
});
