import Link from "next/link";
import { ROLE_LABELS_AR, can } from "@/core/permissions";
import { requireUser } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser();
  return (
    <main className="shell">
      <h1>سيستم 1</h1>
      <p>أهلاً {user.name}. دورك: {ROLE_LABELS_AR[user.role]}.</p>
      <p className="muted">الهيكل جاهز. الميزات بتنضاف مهمة مهمة حسب خطة البناء.</p>
      <nav className="row">
        {can(user.role, "dashboard.view") && <Link href="/today">اليوم</Link>}
        {can(user.role, "dashboard.view") && <Link href="/candidates">المرشحين</Link>}
        {can(user.role, "dashboard.view") && <Link href="/reports">التقارير</Link>}
        {can(user.role, "dashboard.view") && <Link href="/alerts">التنبيهات</Link>}
        {can(user.role, "dashboard.view") && <Link href="/sources">المصادر</Link>}
        {can(user.role, "capture.create") && <Link href="/imports">الاستيراد</Link>}
        {can(user.role, "capture.create") && <Link href="/extension">الإضافة</Link>}
        {can(user.role, "dashboard.view") && <Link href="/dna">الحمض</Link>}
        {can(user.role, "dashboard.view") && <Link href="/calc">الحاسبة</Link>}
        {can(user.role, "settings.manage") && <Link href="/settings">الإعدادات</Link>}
        {can(user.role, "dashboard.view") && <Link href="/libraries">المكتبات</Link>}
        {(can(user.role, "texts.view") || can(user.role, "claims.approve")) && <Link href="/review">المراجعة</Link>}
        {can(user.role, "quality.view") && <Link href="/batches">الدفعات</Link>}
        {can(user.role, "quality.view") && <Link href="/licenses">التراخيص</Link>}
        {can(user.role, "prompts.manage") && <Link href="/agents">الوكلاء</Link>}
        {can(user.role, "prompts.manage") && <Link href="/prompts">مركز البرومبتات</Link>}
        {can(user.role, "prompts.manage") && <Link href="/gateway">بوابة الموديلات</Link>}
        {can(user.role, "users.manage") && <Link href="/users">المستخدمين والأدوار</Link>}
        {can(user.role, "settings.manage") && <Link href="/integrations">الربط بالأنظمة</Link>}
        {can(user.role, "settings.manage") && <Link href="/admin/db">فحص القاعدة</Link>}
        <form action="/api/auth/logout" method="post">
          <button type="submit">خروج</button>
        </form>
      </nav>
    </main>
  );
}
