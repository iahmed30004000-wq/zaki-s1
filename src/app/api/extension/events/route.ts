import { getDb } from "@/lib/db";
import { recordEvent } from "@/extension/captures";
import { jsonBody, withDevice } from "@/extension/device-route";

export const dynamic = "force-dynamic";

// عام عن قصد: محمي بتوكن الجهاز. إشارة توقف (كابتشا · تحقق · دخول) أو «المحددات بدها تحديث»: تنبيه + سجل.
export const POST = withDevice(async ({ req, device }) => Response.json(await recordEvent(getDb(), device, await jsonBody(req))));
