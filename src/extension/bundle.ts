// تنزيل الإضافة كملف مضغوط: مجلد extension كامل + رابط النظام الحالي بالصلاحيات والإعدادات + ملف خطوات التثبيت بوضع المطوّر.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync, strToU8 } from "fflate";

const ROOT = () => join(process.cwd(), "extension");

export function extensionVersion(root = ROOT()): string {
  return String(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// الأصل المسموح للنظام: https أو localhost بس. غير هيك ما بنضيف صلاحية
export function systemOrigin(appUrl: string | undefined): string | null {
  try {
    const u = new URL(appUrl ?? "");
    if (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return u.origin;
  } catch {
    /* بلا رابط */
  }
  return null;
}

export const INSTALL_AR = `تثبيت إضافة سيستم 1 (وضع المطوّر)
=====================================
1) فك ضغط هالملف بمجلد ثابت (مثلاً: Documents\\s1-extension) ولا تحذفه بعدين.
2) افتح كروم وروح على:  chrome://extensions
3) فعّل «وضع المطوّر» (Developer mode) من فوق يمين.
4) اضغط «تحميل غير مضغوط» (Load unpacked) واختار المجلد اللي فكيته.
5) من النظام: شاشة الإضافة ← «جهاز جديد» ← انسخ التوكن.
6) من أيقونة الإضافة ← «الخيارات»: الصق التوكن واضغط «اتصل». لازم يطلع «متصل».

بعد هيك: افتح صفحة منتج على علي إكسبرس أو نتائج مكتبة إعلانات ميتا، بيطلع زر «احفظ كمرشح».
ملاحظة: الإضافة بتشتغل على المواقع المدعومة بس، وبتوقف لحالها عند أي كابتشا أو تحقق أو طلب دخول.
التحديث: لما ينزل ملف جديد، فك الضغط فوق نفس المجلد واضغط زر التحديث (↻) بصفحة الإضافات.
`;

/** ملف zip كامل. appUrl = رابط النظام (APP_URL) عشان نكتبه بالإعدادات ونعطيه صلاحية الاتصال */
export function buildBundle(appUrl: string | undefined, root = ROOT()): Uint8Array {
  const origin = systemOrigin(appUrl);
  const files: Record<string, Uint8Array> = {};
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split("\\").join("/");
    if (rel.endsWith(".md") || rel.startsWith(".")) continue;
    let body: Uint8Array = readFileSync(abs);
    if (rel === "manifest.json" && origin) {
      const m = JSON.parse(readFileSync(abs, "utf8"));
      m.host_permissions = [...new Set([...(m.host_permissions ?? []), `${origin}/*`])];
      body = strToU8(JSON.stringify(m, null, 2));
    }
    files[rel] = body;
  }
  files["defaults.json"] = strToU8(JSON.stringify({ systemUrl: origin ?? "" }, null, 2));
  files["INSTALL_AR.txt"] = strToU8(INSTALL_AR);
  return zipSync(files, { level: 6 });
}
