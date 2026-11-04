import { guard } from "@/lib/api-guard";
import { buildBundle, extensionVersion } from "@/extension/bundle";

export const dynamic = "force-dynamic";

// «نزّل الإضافة»: ملف مضغوط جاهز للتحميل بوضع المطوّر، فيه رابط هالنظام وخطوات التثبيت.
export const GET = guard("capture.create", async ({ audit }) => {
  const zip = buildBundle(process.env.APP_URL);
  audit("Extension", extensionVersion(), null, { download: true });
  return new Response(Buffer.from(zip), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="s1-extension-${extensionVersion()}.zip"`, "cache-control": "no-store" } });
});
