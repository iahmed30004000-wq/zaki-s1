import { withDevice } from "@/extension/device-route";

export const dynamic = "force-dynamic";

// عام عن قصد: محمي بتوكن الجهاز. فحص الاتصال من خيارات الإضافة («متصل»).
export const GET = withDevice(async ({ device }) => Response.json({ ok: true, device: device.name }));
