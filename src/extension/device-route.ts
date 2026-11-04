// غلاف نقاط الإضافة: توكن الجهاز بدل جلسة موظف. قراءة/كتابة محدودة بأقل صلاحية، والأخطاء بشكل موحّد.
import { getDb } from "@/lib/db";
import { drain } from "@/lib/persist";
import { authenticateDevice, extensionErrorResponse, type AuthedDevice } from "./devices";

export function withDevice(handler: (ctx: { req: Request; device: AuthedDevice }) => Promise<Response> | Response) {
  return async (req: Request): Promise<Response> => {
    try {
      const device = await authenticateDevice(getDb(), req.headers.get("authorization"));
      if (!device) return Response.json({ error: { code: "UNAUTHORIZED", message: "توكن الجهاز غلط أو ملغي" } }, { status: 401 });
      const res = await handler({ req, device });
      await drain(); // التنبيهات المرفوعة بالطلب لازم تنحفظ قبل الرد
      return res;
    } catch (e) {
      return extensionErrorResponse(e);
    }
  };
}

export const jsonBody = async (req: Request): Promise<unknown> => req.json().catch(() => null);
