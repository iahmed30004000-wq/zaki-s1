import Link from "next/link";
import { can } from "@/core/permissions";
import { requireUser } from "@/lib/current-user";
import { dbConfigured, getDb } from "@/lib/db";
import { extensionVersion } from "@/extension/bundle";
import { listDevices } from "@/extension/devices";
import { SITE_LABELS_AR, listSets, loadDefaults } from "@/extension/selectors";
import { ActivateButton, NewDevice, PublishSelectors, RevokeButton } from "./panels";

export const dynamic = "force-dynamic";

const STATUS_AR: Record<string, string> = { ok: "انحفظ", duplicate: "مكرر", needs_extraction: "ناقص", stopped: "وقفت (تحقق)", selectors_stale: "المحددات بدها تحديث" };
const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—");

export default async function ExtensionPage() {
  const user = await requireUser("capture.create");
  const admin = can(user.role, "settings.manage");
  if (!dbConfigured()) return <main className="shell"><h1>الإضافة</h1><p className="error" role="alert">القاعدة مش متصلة.</p></main>;
  const db = getDb();
  const [devices, sets, jobs] = await Promise.all([
    listDevices(db, admin ? {} : { userSub: user.sub }),
    listSets(db),
    db.captureJob.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  const sample = JSON.stringify(sets.find((s) => s.active)?.selectors ?? loadDefaults()[0], null, 2);
  return (
    <main className="shell wide">
      <p><Link href="/">← الرئيسية</Link></p>
      <h1>الإضافة والأجهزة</h1>
      <p className="muted">إضافة كروم بتحفظ صفحات علي إكسبرس ومكتبة إعلانات ميتا كمرشحين بسرعة إنسان، وبتوقف لحالها عند أي كابتشا أو تحقق. النسخة الحالية: {extensionVersion()}</p>

      <section>
        <h2>التنزيل والتثبيت</h2>
        <p><a href="/api/extension/download" download>نزّل الإضافة (ملف مضغوط)</a></p>
        <ol>
          <li>فك الضغط بمجلد ثابت.</li>
          <li>كروم: <code dir="ltr">chrome://extensions</code> ← فعّل «وضع المطوّر» ← «تحميل غير مضغوط» ← اختار المجلد.</li>
          <li>«جهاز جديد» تحت ← انسخ التوكن ← خيارات الإضافة ← الصقه ← «اتصل» (لازم يطلع «متصل»).</li>
        </ol>
      </section>

      <section>
        <h2>الأجهزة</h2>
        <NewDevice />
        <table data-testid="devices">
          <thead><tr><th>الجهاز</th><th>صاحبه</th><th>آخر اتصال</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} data-device={d.name}>
                <td>{d.name}</td>
                <td>{d.owner}</td>
                <td dir="ltr">{when(d.lastSeenAt)}</td>
                <td>{d.active ? "فعّال" : "ملغي"}</td>
                <td>{d.active && <RevokeButton id={d.id} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>المحددات (تتحدّث عن بُعد)</h2>
        <p className="muted">لو موقع غيّر شكله والإضافة وقفت بـ«المحددات بدها تحديث»: عدّل الملف ونزّل نسخة جديدة هون، والإضافات بتاخدها بالتحديث الجاي (أو زر «حدّث المحددات الآن» بخياراتها). ما في إعادة تثبيت.</p>
        <table data-testid="selectors">
          <thead><tr><th>الموقع</th><th>النسخة</th><th>الحالة</th><th>انتشرت</th><th></th></tr></thead>
          <tbody>
            {sets.map((s) => (
              <tr key={`${s.site}-${s.version}`} data-site={s.site} data-active={s.active ? "1" : "0"}>
                <td>{SITE_LABELS_AR[s.site] ?? s.site}</td>
                <td>{s.version}</td>
                <td>{s.active ? "فعّالة" : "قديمة"}</td>
                <td dir="ltr">{when(s.createdAt)}</td>
                <td>{admin && !s.active && <ActivateButton site={s.site} version={s.version} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {admin && <PublishSelectors sample={sample} />}
      </section>

      <section>
        <h2>آخر اللقطات</h2>
        <table data-testid="jobs">
          <thead><tr><th>الوقت</th><th>الموقع</th><th>النتيجة</th><th>تفاصيل</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} data-status={j.status}>
                <td dir="ltr">{when(j.createdAt)}</td>
                <td>{SITE_LABELS_AR[j.site] ?? j.site}</td>
                <td>{STATUS_AR[j.status] ?? j.status}</td>
                <td>{j.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
