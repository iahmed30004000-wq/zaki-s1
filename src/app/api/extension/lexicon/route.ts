import { getDb } from "@/lib/db";
import { withDevice } from "@/extension/device-route";
import { lexicon } from "@/extension/selectors";

export const dynamic = "force-dynamic";

// عام عن قصد: محمي بتوكن الجهاز. قاموس النية والتشكيك: الإضافة بتعدّ فيه محلياً وبترسل العدد بس.
export const GET = withDevice(async () => Response.json({ lexicon: await lexicon(getDb()) }));
