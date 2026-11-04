// توجيه التنبيهات: اللوحة دايماً (جدول Alert)، وتيليجرام للمهم بس: الحرج + أنواع محددة (وكيل وقف · رخصة · دفعة بلا شهادة · شكاوى · اختبار ترند جاهز · أداء ضعيف).
import { s1PublicUrl } from "@/adapters/config";
import type { AlertEntry } from "@/lib/alerts";
import { sinks } from "@/lib/hooks";
import { openButton } from "./keyboards";
import { sendToOwner, type Deps } from "./client";

const TELEGRAM_TYPES = new Set(["budget", "license_expiring", "batch_no_certificate", "complaints_spike", "trend_ready", "underperforming", "outbound_dead", "extension_stopped"]);

// أي نوع بيفتح شاشته: «افتح الوكلاء» لتوقف الوكيل مثلاً
const TARGET: Record<string, { label: string; path: string }> = {
  budget: { label: "افتح الوكلاء", path: "/agents" },
  license_expiring: { label: "افتح التراخيص", path: "/licenses" },
  batch_no_certificate: { label: "افتح الدفعات", path: "/batches" },
  outbound_dead: { label: "افتح الربط", path: "/integrations" },
  extension_stopped: { label: "افتح الإضافة", path: "/extension" },
};

export const shouldNotifyTelegram = (a: Pick<AlertEntry, "type" | "severity">) => a.severity === "critical" || TELEGRAM_TYPES.has(a.type);

export async function routeAlert(a: AlertEntry, deps: Deps = {}) {
  if (!shouldNotifyTelegram(a)) return { sent: false as const };
  const t = TARGET[a.type] ?? { label: "افتح التنبيهات", path: "/alerts" };
  const url = a.link ? (a.link.startsWith("http") ? a.link : s1PublicUrl(a.link)) : s1PublicUrl(t.path);
  const r = await sendToOwner(`تنبيه: ${a.message}`, openButton(t.label, url), deps);
  return { sent: r.ok, mock: r.mock };
}

// بيتركّب مع طبقة التخزين (persist.ts): الإرسال بالخلفية وما بيوقف المسار اللي رفع التنبيه
export function installAlertRouting() {
  sinks.notify = (a) => {
    void routeAlert(a).catch(() => undefined);
  };
}
