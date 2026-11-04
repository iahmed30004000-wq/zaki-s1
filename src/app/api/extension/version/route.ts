import { withDevice } from "@/extension/device-route";
import { extensionVersion } from "@/extension/bundle";

export const dynamic = "force-dynamic";

// عام عن قصد: محمي بتوكن الجهاز. نسخة الإضافة الأحدث وطريقة التنزيل (شريط «في نسخة جديدة»).
export const GET = withDevice(async () => Response.json({ version: extensionVersion(), download: "/api/extension/download" }));
